// test/costing/costing-lifecycle.route.test.js
//
// Central Costing — Chunk 6A. REVIEW AND APPROVAL.
//
// A calculated version is a number. A commercial one is a number somebody put
// forward and somebody else agreed to, on a date, for a reason. This proves
// the things only the lifecycle can be wrong about:
//
//   · that a draft cannot become approved without a review;
//   · that approving is a separate authority from calculating;
//   · that approving V2 leaves exactly ONE approved version, not two;
//   · that creating V3 does not change what Sales is quoting from V2;
//   · that a transition publishes the engine's own prices and changes NOTHING
//     about the frozen content it moves;
//   · and that an output-only reader learns the price and nothing else — not
//     the drafts, not the approver, not that an argument happened.
"use strict";
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const {
  seedSourceBacked, configureProduction, EVERY_FAMILY, CONFIRMED_TERMS, approveFinancingPolicy, prepareForCosting } = require("./helpers/sourceBacked");

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

const { MongoMemoryReplSet } = require("mongodb-memory-server");

let server, base, rs, seq = 0;

/* ── A REPLICA SET, BECAUSE THE CLAIMS ARE ABOUT TRANSACTIONS ───────────────
 * The shared harness runs a standalone mongod, which hands out sessions and
 * then refuses the first write inside a transaction. Every atomicity and
 * concurrency assertion below would either fail for the wrong reason or pass
 * without proving anything. This file starts its own replica set so
 * `startTransaction`, `commitTransaction` and `abortTransaction` mean what
 * they say — and so the "transactions are required" refusal can be tested by
 * its absence rather than by its presence. */
beforeAll(async () => {
  await mongoose.disconnect();
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(rs.getUri(), { dbName: "costing_lifecycle" });

  const app = express();
  app.use(express.json());
  app.use("/api/costings", require("../../routes/CMS_Routes/Costing/costings"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/costings`;
}, 180000);

afterAll(async () => {
  await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  if (rs) await rs.stop();
});
afterEach(() => { jest.restoreAllMocks(); });

const newKey = () => `lc-${++seq}-${Math.random().toString(36).slice(2)}`;

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
  const email = `chunk6a-${n}@test.example`;
  const emp = await Employee.create({
    firstName: "A", lastName: `L${n}`, email, biometricId: `C6A${n}`,
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

/* ── WHAT THE TEST POSTS, AND WHAT IT NO LONGER POSTS ─────────────────────
 * The shell fabric and the stitching used to be typed here. They are
 * assembled now — the technical record gives the consumption and the SAM, the
 * supplier quotation gives the material rate, the company's production
 * assumptions give the labour rate — so this suite posts nothing for either.
 *
 * Cutting wastage and the pattern-and-marker charge have no authoritative
 * record anywhere in this repository, so they are declared overrides: a
 * family, a reason, and PROVISIONAL on the frozen version. This suite needs
 * them because a costing has to be COMPLETE to pass the review gate. */
/* ── AND NOTHING IS TYPED ────────────────────────────────────────────
   Two declared overrides stood here — a cutting-wastage percentage and a
   pattern-and-marker charge — because neither had "an authoritative record
   anywhere in this repository". Development does now (R&D records the setup
   work, a supplier quotes it), and the seed below states it; wastage is part
   of the materials family, whose consumption the technical record already
   carries.

   `LINES` stays as a name because every call site reads it, and an empty
   array spelled out at each one would hide the fact that this suite sends no
   cost lines at all. */
const LINES = [];

/* ── ANSWERING EVERY COST FAMILY, FROM RECORDS ────────────────────────────
   `ACKNOWLEDGEMENTS` stood here: six `{key, reason}` entries posted with the
   calculation, answering services, packaging, freight, duty, financing and
   overhead "exactly as a user would".

   No user does that any more. Each of those six is a fact somebody else owns,
   and Costing reads their record: the seed gives this style a packaging
   requirement and an outside process with quotations behind them, an ex-works
   enquiry (the customer collects, so freight is a recorded zero), confirmed
   payment terms and an approved Board financing policy, domestic sourcing on
   the quotation, and — through `configureProduction` — an approved overhead
   policy.

   So the calculation posts nothing but scenarios, and a payload still carrying
   an acknowledgement is refused. The lifecycle assertions below are
   unchanged. */

const SCENARIOS = [
  { key: "q500", label: "500 pcs", quantity: "500", isPrimary: true },
  { key: "q2000", label: "2000 pcs", quantity: "2000" },
];

/** A company with a policy, an admin actor, and a costing to work on. */
async function setup({ name = "Co" } = {}) {
  const co = await company(name);
  const me = await actor({ companies: [co], admin: true });
  await call("/policy/current", { method: "PUT", token: me.token, company: co._id, body: policyBody(0) });
  /* ── IT USED TO BE `{ context: { type: "ADHOC" } }` ────────────────────
     Two lines and no fixtures. The fixture seeds the enquiry product, the
     technical record, the supplier quotation and the production assumptions a
     real costing stands on; every lifecycle assertion below is unchanged. */
  await approveFinancingPolicy(co._id);
  const seeded = await seedSourceBacked(co._id, { brief: { quantities: SCENARIOS, quantityUom: "Pieces" },
    ...EVERY_FAMILY,
    paymentTerms: { ...CONFIRMED_TERMS },
    /* The one-time setup charge these lifecycle tests need in the build-up,
       from the two records that answer it. */
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

const calculate = (
  me, co, costingId,
  body = { lines: LINES },
  key = newKey(),
) => (payloadContract(body)
  ? call(`/${costingId}/versions`, { method: "POST", token: me.token, company: co._id, idempotencyKey: key, body })
  : prepareForCosting(costingId, { actionKey: key }));

const CostingTransition = require("../../models/CMS_Models/Costing/CostingTransition");

const NOTE = "Checked against the March supplier quote.";
const submit = (who, co, id, vid, body = {}, key = newKey()) =>
  call(`/${id}/versions/${vid}/submit`, {
    method: "POST", token: who.token, company: co._id, idempotencyKey: key, body,
  });
const approve = (who, co, id, vid, body = { note: NOTE }, key = newKey()) =>
  call(`/${id}/versions/${vid}/approve`, {
    method: "POST", token: who.token, company: co._id, idempotencyKey: key, body,
  });

/**
 * The version with THIS id, out of a response that carries all of them.
 *
 * `versions[0]` is not it: creating a costing makes an empty version 1, so
 * the first CALCULATED version is 2 — and a positional read silently asserted
 * against the empty draft instead.
 */
const versionOf = (body, id) => (body.versions || []).find((v) => String(v.id) === String(id));

/**
 * SALES ADDS A RUN SIZE, SO THERE IS SOMETHING NEW TO COST.
 *
 * ── WHY A FIXTURE HAS TO DO THIS NOW ────────────────────────────────────────
 * `POST /:id/versions` made a version every time it was called, so a test
 * needing a second one simply called it twice. The orchestration will not: it
 * compares the resolved source fingerprint against the one the last version
 * froze, and identical sources produce no version at all. That is the whole
 * point — it is what makes the button safe to press twice and safe to leave on
 * a page somebody reloads.
 *
 * So a test that needs a genuinely later version has to give it a genuinely
 * later reason, and the honest one is the commercial fact Sales owns: another
 * quantity to be quoted. It is also a real second calculation, because the
 * fixed costs dilute differently across it.
 */
let widened = 0;
async function widenBrief(seeded) {
  const enquiry = await Enquiry.findById(seeded.enquiry._id);
  /* Never a key `SCENARIOS` already uses: a duplicate is refused by the
     parser, and the failure would read as the orchestration breaking. */
  const extra = 100000 + (++widened);
  enquiry.costingBriefs[0].quantities = [
    ...SCENARIOS.map((sc) => ({ ...sc, quantity: String(sc.quantity) })),
    { key: `q${extra}`, label: `${extra} pcs`, quantity: String(extra), isPrimary: false },
  ];
  enquiry.markModified("costingBriefs");
  await enquiry.save();
}

/** A calculated version, ready to move. */
async function calculated(name = "LC") {
  const { co, me, costingId, seeded } = await setup({ name });
  const made = await calculate(me, co, costingId);
  if (made.status !== 201) throw new Error(`calculate refused: ${made.status} ${JSON.stringify(made.body).slice(0, 600)}`);
  return { co, me, costingId, seeded, version: made.body.versions[0] };
}

/* ═══ 1 · WHERE A VERSION STARTS ═════════════════════════════════════════ */

describe("a calculated version is not yet a commercial one", () => {
  test("it begins as a draft, publishing nothing", async () => {
    const { version } = await calculated("Start");
    expect(version.status).toBe("DRAFT");
    /* Calculating produced numbers and no commercial answer — which is
       exactly what the screen has to say, because calculating feels like
       finishing. */
    expect(version.output?.approved).toBe(false);
    expect(version.actions.canSubmitForReview).toBe(true);
    expect(version.actions.canApprove).toBe(false);
  });

  test("a draft cannot be approved without a review", async () => {
    const { co, me, costingId, version } = await calculated("Skip");
    const r = await approve(me, co, costingId, version.id);
    expect(r.status).toBe(409);
    /* Refused BY NAME. The review step is the control, and skipping it is
       the thing this lifecycle exists to prevent. */
    expect(r.body.error.code).toBe("COSTING_INVALID_TRANSITION");
    expect(r.body.error.details.allowed).toEqual(["IN_REVIEW"]);

    const still = await call(`/${costingId}`, { token: me.token, company: co._id });
    expect(versionOf(still.body, version.id).status).toBe("DRAFT");
  });
});

/* ═══ 2 · SUBMIT ═════════════════════════════════════════════════════════ */

describe("submit for review", () => {
  test("it succeeds once and records who and when", async () => {
    const { co, me, costingId, version } = await calculated("Submit");
    const before = Date.now() - 1000;

    const r = await submit(me, co, costingId, version.id, { note: "Ready for pricing." });
    expect(r.status).toBe(200);
    const v = versionOf(r.body, version.id);
    expect(v.status).toBe("IN_REVIEW");
    expect(v.lifecycle.submittedByName).toBeTruthy();
    /* The SERVER's clock — a client timestamp is a claim by the party being
       audited. */
    expect(new Date(v.lifecycle.submittedAt).getTime()).toBeGreaterThanOrEqual(before);
    expect(v.lifecycle.submissionNote).toBe("Ready for pricing.");

    const evidence = await CostingTransition.find({ versionId: version.id }).lean();
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({ kind: "SUBMIT", fromStatus: "DRAFT", toStatus: "IN_REVIEW" });
    expect(evidence[0].actorId).toBeTruthy();
  });

  test("submitting twice is a conflict, not a silent second submission", async () => {
    const { co, me, costingId, version } = await calculated("Twice");
    expect((await submit(me, co, costingId, version.id)).status).toBe(200);

    /* A DIFFERENT key, so this is a genuinely second action rather than a
       retry — and it must not look like it worked. */
    const again = await submit(me, co, costingId, version.id, {}, newKey());
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("COSTING_VERSION_STATE_CONFLICT");
    expect(await CostingTransition.countDocuments({ versionId: version.id })).toBe(1);
  });

  test("a Sales reader cannot submit somebody else's costing forward", async () => {
    const { co, costingId, version } = await calculated("SalesSubmit");
    const sales = await actor({ companies: [co], grant: "sales" });
    expect((await submit(sales, co, costingId, version.id)).status).toBe(403);
  });
});

/* ═══ 3 · APPROVE ════════════════════════════════════════════════════════ */

describe("approve", () => {
  test("it requires costing.approve, not merely the ability to calculate", async () => {
    const { co, me, costingId, version } = await calculated("Auth");
    await submit(me, co, costingId, version.id);

    const editor = await actor({ companies: [co] });
    jest.spyOn(capabilityService, "resolveCapabilities").mockResolvedValue({
      capabilities: [CAPABILITIES.COST_READ, CAPABILITIES.DRAFT_WRITE], via: ["test"], isAdmin: false,
    });
    const r = await approve(editor, co, costingId, version.id);
    expect(r.status).toBe(403);
    /* And the version did not move. */
    jest.restoreAllMocks();
    const still = await call(`/${costingId}`, { token: me.token, company: co._id });
    expect(versionOf(still.body, version.id).status).toBe("IN_REVIEW");
  });

  test("an approval needs a reason, and a keystroke is not one", async () => {
    const { co, me, costingId, version } = await calculated("Note");
    await submit(me, co, costingId, version.id);

    for (const note of [undefined, "", "   ", "ok"]) {
      const r = await approve(me, co, costingId, version.id, { note });
      expect(r.status).toBe(400);
      /* An approval with no stated reason is a signature on a blank page. */
      expect(r.body.error.code).toBe("COSTING_APPROVAL_NOTE_REQUIRED");
    }
    const still = await call(`/${costingId}`, { token: me.token, company: co._id });
    expect(versionOf(still.body, version.id).status).toBe("IN_REVIEW");
  });

  test("it records the approver, the reason and the policy revision it judged against", async () => {
    const { co, me, costingId, version } = await calculated("Approve");
    await submit(me, co, costingId, version.id);
    const r = await approve(me, co, costingId, version.id);
    expect(r.status).toBe(200);

    const v = versionOf(r.body, version.id);
    expect(v.status).toBe("APPROVED");
    expect(v.lifecycle.approvalNote).toBe(NOTE);
    expect(v.lifecycle.approvedAt).toBeTruthy();
    /* Without the policy revision, a later policy change makes every historic
       approval look as though it had been judged against today's floor. */
    expect(v.lifecycle.policyRevisionAtApproval).toBe(1);

    const evidence = await CostingTransition.findOne({ versionId: version.id, kind: "APPROVE" }).lean();
    expect(evidence).toMatchObject({ fromStatus: "IN_REVIEW", toStatus: "APPROVED", note: NOTE, policyRevision: 1 });
    expect(evidence.idempotencyKey).toBeTruthy();
  });

  test("approval publishes the engine's own price breaks, unrecomputed", async () => {
    const { co, me, costingId, version } = await calculated("Publish");
    /* What the engine calculated when the version was frozen. */
    const frozen = await CostingVersion.findById(version.id).lean();
    const primary = frozen.scenarios.find((s) => s.key === "q500");

    await submit(me, co, costingId, version.id);
    const r = await approve(me, co, costingId, version.id);
    const out = versionOf(r.body, version.id).output;

    expect(out.approved).toBe(true);
    const br = out.quantityBreaks.find((b) => b.key === "q500");
    /* The SAME integer, not a number the client or the route worked out. */
    expect(br.floorPriceMinor).toBe(primary.floor.floorPriceMinor);
    expect(br.pricingContract).toBe("MARKUP_FLOOR_V2");
    /* One price, and the retired tiers published as null rather than absent —
       a consumer written for the band reads an explicit "this version has
       none" instead of finding the keys missing and inferring. */
    expect(br.minimumPriceMinor).toBeNull();
    expect(br.targetPriceMinor).toBeNull();
    expect(br.preferredPriceMinor).toBeNull();
  });
});

/* ═══ 4 · THE TRANSITION CHANGES NOTHING ELSE ════════════════════════════ */

describe("a lifecycle move does not touch frozen content", () => {
  test("cost lines, scenarios, policy snapshot, provenance and totals survive intact", async () => {
    const { co, me, costingId, version } = await calculated("Frozen");
    const before = await CostingVersion.findById(version.id).lean();

    await submit(me, co, costingId, version.id);
    await approve(me, co, costingId, version.id);
    const after = await CostingVersion.findById(version.id).lean();

    /* Everything except the two fields the lifecycle owns. */
    for (const field of ["inputs", "scenarios", "policySnapshot", "provenance", "calculation", "sourceReferences"]) {
      expect(JSON.stringify(after[field])).toBe(JSON.stringify(before[field]));
    }
    expect(after.versionNumber).toBe(before.versionNumber);
    expect(after.baseCurrency).toBe(before.baseCurrency);
  });

  test("the immutability guard still refuses an ordinary write", async () => {
    const { version } = await calculated("Guard");
    const doc = await CostingVersion.findById(version.id);
    doc.status = "APPROVED";
    /* No arming, so this is an ordinary save — and the door A1.5 closed is
       still closed. */
    await expect(doc.save()).rejects.toThrow(/immutable once created/);

    /* And the query paths gained nothing at all. */
    await expect(
      CostingVersion.updateOne({ _id: version.id }, { $set: { status: "APPROVED" } }),
    ).rejects.toThrow(/immutable once created/);
    await expect(
      CostingVersion.findOneAndUpdate({ _id: version.id }, { $set: { status: "APPROVED" } }),
    ).rejects.toThrow(/immutable once created/);
  });

  test("an armed transition still cannot smuggle a content edit alongside it", async () => {
    const { version } = await calculated("Smuggle");
    const doc = await CostingVersion.findById(version.id);
    CostingVersion.beginLifecycleTransition(doc);
    doc.status = "IN_REVIEW";
    doc.baseCurrency = "USD";
    /* The door opens for `status` and `lifecycle`. Everything else is
       content, armed or not — which is the whole promise. */
    await expect(doc.save()).rejects.toThrow(/baseCurrency/);
  });

  test("the token is spent on one save and does not stay open", async () => {
    const { version } = await calculated("Spent");
    const doc = await CostingVersion.findById(version.id);
    CostingVersion.beginLifecycleTransition(doc);
    doc.status = "IN_REVIEW";
    await doc.save();

    doc.status = "APPROVED";
    /* A token that survived its save would leave the door open for the next
       one — which is a global bypass with extra steps. */
    await expect(doc.save()).rejects.toThrow(/immutable once created/);
  });
});

/* ═══ 5 · ONE CURRENT COMMERCIAL ANSWER, EVER ════════════════════════════ */

describe("approving a later version supersedes the earlier one", () => {
  test("approving V2 leaves exactly one approved version", async () => {
    const { co, me, costingId, seeded, version: v1 } = await calculated("Supersede");
    await submit(me, co, costingId, v1.id);
    await approve(me, co, costingId, v1.id);

    await widenBrief(seeded);
    const v2 = (await calculate(me, co, costingId)).body.versions[0];
    await submit(me, co, costingId, v2.id);
    const r = await approve(me, co, costingId, v2.id, { note: "Fabric rate renegotiated." });
    expect(r.status).toBe(200);

    /* The count, not the pair — two approved versions is the failure this
       whole operation exists to prevent, and it would be invisible on every
       screen. */
    const approved = await CostingVersion.find({ costingId, status: "APPROVED" }).lean();
    expect(approved).toHaveLength(1);
    expect(String(approved[0]._id)).toBe(String(v2.id));

    const old = await CostingVersion.findById(v1.id).lean();
    expect(old.status).toBe("SUPERSEDED");
    /* A superseded record explains itself without a search. */
    expect(old.lifecycle.supersededByVersionNumber).toBe(v2.versionNumber);
    expect(old.lifecycle.supersededAt).toBeTruthy();

    /* And the supersession is evidence too, not a silent side effect. */
    const ev = await CostingTransition.findOne({ versionId: v1.id, kind: "SUPERSEDE" }).lean();
    expect(ev).toMatchObject({ fromStatus: "APPROVED", toStatus: "SUPERSEDED" });
    expect(ev.causedByVersionNumber).toBe(v2.versionNumber);
  });

  test("the parent points at the approved version, not the newest one", async () => {
    const { co, me, costingId, seeded, version: v1 } = await calculated("Pointer");
    await submit(me, co, costingId, v1.id);
    await approve(me, co, costingId, v1.id);

    /* A NEW draft. `currentVersion` moves; the approved one must not. */
    await widenBrief(seeded);
    const v2 = (await calculate(me, co, costingId)).body.versions[0];
    const r = await call(`/${costingId}`, { token: me.token, company: co._id });
    expect(r.body.costing.currentVersion.number).toBe(v2.versionNumber);
    expect(r.body.costing.approvedVersion.number).toBe(v1.versionNumber);
    /* Overloading one field for both would mean creating a draft silently
       changed the price Sales was quoting — a change nobody made. */
    expect(r.body.costing.approvedVersion.id).toBe(v1.id);
  });

  test("an older version cannot displace a newer approved one", async () => {
    const { co, me, costingId, seeded, version: v1 } = await calculated("Backwards");
    await widenBrief(seeded);
    const v2 = (await calculate(me, co, costingId)).body.versions[0];

    await submit(me, co, costingId, v1.id);
    await submit(me, co, costingId, v2.id);
    await approve(me, co, costingId, v2.id);

    /* v1 was reviewed and is still IN_REVIEW — a stale approval landing now
       would quietly demote the newer answer to the older. */
    const late = await approve(me, co, costingId, v1.id, { note: "Approving the old one." });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe("COSTING_APPROVAL_CONFLICT");

    const approved = await CostingVersion.find({ costingId, status: "APPROVED" }).lean();
    expect(approved).toHaveLength(1);
    expect(approved[0].versionNumber).toBe(v2.versionNumber);
  });
});

/* ═══ 6 · WHAT SALES SEES ════════════════════════════════════════════════ */

describe("an output-only reader", () => {
  /** A Sales grant: costing.output.read and nothing else. */
  const asSales = () => jest.spyOn(capabilityService, "resolveCapabilities").mockResolvedValue({
    capabilities: [CAPABILITIES.OUTPUT_READ], via: ["test"], isAdmin: false,
  });

  test("cannot see a costing that has never been approved", async () => {
    const { co, me, costingId, version } = await calculated("SalesDraft");
    await submit(me, co, costingId, version.id);
    const sales = await actor({ companies: [co], grant: "sales" });
    asSales();
    /* A draft under review is not a commercial answer, and its EXISTENCE is
       not Sales' business either — so it is the same 404 as a costing in
       another company. */
    expect((await call(`/${costingId}`, { token: sales.token, company: co._id })).status).toBe(404);
  });

  test("sees the approved prices, and nothing about how they were reached", async () => {
    const { co, me, costingId, version } = await calculated("SalesApproved");
    await submit(me, co, costingId, version.id);
    await approve(me, co, costingId, version.id);

    const sales = await actor({ companies: [co], grant: "sales" });
    asSales();
    const r = await call(`/${costingId}`, { token: sales.token, company: co._id });
    expect(r.status).toBe(200);

    const v = versionOf(r.body, version.id);
    expect(v.output.approved).toBe(true);
    expect(v.output.quantityBreaks.length).toBeGreaterThan(0);
    /* The price, and not the argument that produced it. */
    expect(v.cost).toBeUndefined();
    expect(v.margin).toBeUndefined();
    expect(v.lifecycle).toBeUndefined();
    expect(v.actions).toBeUndefined();
    expect(r.body.visibility.withheld).toEqual(expect.arrayContaining(["cost", "margin"]));

    const text = JSON.stringify(r.body);
    expect(text).not.toContain("approvalNote");
    expect(text).not.toContain(NOTE);
  });

  test("a new draft does not change the price Sales is quoting, or reveal itself", async () => {
    const { co, me, costingId, seeded, version: v1 } = await calculated("SalesV3");
    await submit(me, co, costingId, v1.id);
    await approve(me, co, costingId, v1.id);

    const sales = await actor({ companies: [co], grant: "sales" });
    asSales();
    const before = await call(`/${costingId}`, { token: sales.token, company: co._id });
    const priced = versionOf(before.body, v1.id).output.quantityBreaks;

    jest.restoreAllMocks();
    /* V3, calculated with a different rate — nobody has approved it. */
    /* ── A LATER DRAFT OF THE SAME SOURCES ──────────────────────────
       This re-costed with the fabric rate typed up to 99000, which a
       fixture cannot do any more. A third run size is a genuinely different
       calculation and serves the same purpose: the assertions below are
       about V3 being INVISIBLE to Sales, not about what it costs. */
    /* Sales adds a run size to the brief; the costing re-reads it. The
       assertions below are about V3 being INVISIBLE to Sales' output reader,
       not about what it costs. */
    const enquiry = await Enquiry.findById(seeded.enquiry._id);
    enquiry.costingBriefs[0].quantities = [
      ...SCENARIOS.map((sc) => ({ ...sc, quantity: String(sc.quantity) })),
      { key: "q9000", label: "9000 pcs", quantity: "9000", isPrimary: false },
    ];
    enquiry.markModified("costingBriefs");
    await enquiry.save();
    const v3 = (await calculate(me, co, costingId, { lines: [] })).body.versions[0];

    asSales();
    const after = await call(`/${costingId}`, { token: sales.token, company: co._id });
    /* The same price, from the same version. A draft is not a price change. */
    expect(versionOf(after.body, v1.id).output.quantityBreaks).toEqual(priced);
    /* And V3 is not in the payload at all — not its id, not its number, not
       a hint that a newer one exists. */
    expect(versionOf(after.body, v3.id)).toBeUndefined();
    expect(JSON.stringify(after.body)).not.toContain(String(v3.id));
    expect(after.body.costing.approvedVersion.number).toBe(v1.versionNumber);
  });

  test("cannot submit or approve anything", async () => {
    const { co, me, costingId, version } = await calculated("SalesWrite");
    const sales = await actor({ companies: [co], grant: "sales" });
    expect((await submit(sales, co, costingId, version.id)).status).toBe(403);
    expect((await approve(sales, co, costingId, version.id)).status).toBe(403);
  });
});

/* ═══ 7 · IDEMPOTENCY AND THE COMPANY BOUNDARY ═══════════════════════════ */

describe("repeating an action", () => {
  test("the same key returns one consistent result and moves nothing twice", async () => {
    const { co, me, costingId, version } = await calculated("Replay");
    const key = newKey();

    const first = await submit(me, co, costingId, version.id, { note: "Please review." }, key);
    const second = await submit(me, co, costingId, version.id, { note: "Please review." }, key);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(versionOf(second.body, version.id).status).toBe("IN_REVIEW");
    /* One action, one record — which is what makes a retry of a dropped
       response safe, and what stops a double-click submitting twice. */
    expect(await CostingTransition.countDocuments({ versionId: version.id, kind: "SUBMIT" })).toBe(1);
  });

  test("the same key with a changed body is a conflict, not a quiet replay", async () => {
    const { co, me, costingId, version } = await calculated("Changed");
    const key = newKey();
    expect((await submit(me, co, costingId, version.id, { note: "First reason." }, key)).status).toBe(200);

    const changed = await submit(me, co, costingId, version.id, { note: "A different reason." }, key);
    /* Replaying a key against a different request would answer the second
       question with the first one's result. */
    expect(changed.status).toBe(409);
    expect(changed.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  test("a repeated approval with the same key approves once", async () => {
    const { co, me, costingId, version } = await calculated("ApproveTwice");
    await submit(me, co, costingId, version.id);
    const key = newKey();

    const a = await approve(me, co, costingId, version.id, { note: NOTE }, key);
    const b = await approve(me, co, costingId, version.id, { note: NOTE }, key);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(await CostingTransition.countDocuments({ versionId: version.id, kind: "APPROVE" })).toBe(1);
    expect(await CostingVersion.countDocuments({ costingId, status: "APPROVED" })).toBe(1);
  });
});

describe("the company boundary", () => {
  test("submitting or approving another company's version is not found, not forbidden", async () => {
    const mine = await calculated("Mine");
    const theirs = await calculated("Theirs");

    /* An actor in company A, naming company A, pointing at B's costing. A 403
       would confirm the id exists — which is the disclosure the boundary is
       there to prevent. */
    const s = await call(`/${theirs.costingId}/versions/${theirs.version.id}/submit`, {
      method: "POST", token: mine.me.token, company: mine.co._id,
      idempotencyKey: newKey(), body: {},
    });
    expect(s.status).toBe(404);

    const a = await call(`/${theirs.costingId}/versions/${theirs.version.id}/approve`, {
      method: "POST", token: mine.me.token, company: mine.co._id,
      idempotencyKey: newKey(), body: { note: NOTE },
    });
    expect(a.status).toBe(404);
    expect(a.body.error.code).toBe("NOT_FOUND");

    /* Identical to a costing that never existed. */
    const ghost = await call(`/${new mongoose.Types.ObjectId()}/versions/${new mongoose.Types.ObjectId()}/approve`, {
      method: "POST", token: mine.me.token, company: mine.co._id,
      idempotencyKey: newKey(), body: { note: NOTE },
    });
    expect(ghost.status).toBe(404);
    expect(ghost.body.error).toEqual(a.body.error);

    expect(await CostingVersion.findById(theirs.version.id).lean().then((v) => v.status)).toBe("DRAFT");
  });

  test("a version id from another costing in the SAME company is also not found", async () => {
    const { co, me, costingId } = await calculated("SameCo");
    const other = await setup({ name: "SameCoOther" });
    const otherVersion = (await calculate(other.me, other.co, other.costingId)).body.versions[0];

    /* The version must belong to the costing in the URL — otherwise the
       costing id becomes decorative and the version id does all the work. */
    const r = await call(`/${costingId}/versions/${otherVersion.id}/submit`, {
      method: "POST", token: me.token, company: co._id, idempotencyKey: newKey(), body: {},
    });
    expect(r.status).toBe(404);
  });
});

/* ═══ 8 · TWO GAPS THE FIRST PASS LEFT ═══════════════════════════════════ */

describe("gaps found by neutralising the guards", () => {
  test("the version-history route gives Sales the approved version only", async () => {
    const { co, me, costingId, seeded, version: v1 } = await calculated("History");
    await submit(me, co, costingId, v1.id);
    await approve(me, co, costingId, v1.id);
    await widenBrief(seeded);
    const v2 = (await calculate(me, co, costingId)).body.versions[0];

    const sales = await actor({ companies: [co], grant: "sales" });
    jest.spyOn(capabilityService, "resolveCapabilities").mockResolvedValue({
      capabilities: [CAPABILITIES.OUTPUT_READ], via: ["test"], isAdmin: false,
    });

    /* Nothing tested this endpoint as an output-only reader, so narrowing it
       could be removed without a single failure — while the route handed back
       every draft that had ever existed. */
    const r = await call(`/${costingId}/versions`, { token: sales.token, company: co._id });
    expect(r.status).toBe(200);
    expect(r.body.versions).toHaveLength(1);
    expect(r.body.versions[0].id).toBe(v1.id);
    expect(JSON.stringify(r.body)).not.toContain(String(v2.id));

    /* An internal reader still gets the whole history — that is what the
       endpoint is for. */
    jest.restoreAllMocks();
    const internal = await call(`/${costingId}/versions`, { token: me.token, company: co._id });
    expect(internal.body.versions.length).toBeGreaterThanOrEqual(3);
  });

  test("the parent points at the version APPROVED, not at the newest one", async () => {
    const { co, me, costingId, seeded, version: v1 } = await calculated("PointerStrict");
    /* v2 exists and is the CURRENT version before anything is approved. The
       earlier test approved v1 while it was also current, so a pointer that
       simply copied `currentVersionId` passed it. */
    await widenBrief(seeded);
    const v2 = (await calculate(me, co, costingId)).body.versions[0];
    expect(v2.versionNumber).toBeGreaterThan(v1.versionNumber);

    await submit(me, co, costingId, v1.id);
    await approve(me, co, costingId, v1.id);

    const r = await call(`/${costingId}`, { token: me.token, company: co._id });
    expect(r.body.costing.currentVersion.number).toBe(v2.versionNumber);
    expect(r.body.costing.approvedVersion.number).toBe(v1.versionNumber);
    expect(r.body.costing.approvedVersion.id).toBe(v1.id);

    /* And Sales resolves the approved one, not the current one. */
    const sales = await actor({ companies: [co], grant: "sales" });
    jest.spyOn(capabilityService, "resolveCapabilities").mockResolvedValue({
      capabilities: [CAPABILITIES.OUTPUT_READ], via: ["test"], isAdmin: false,
    });
    const s = await call(`/${costingId}`, { token: sales.token, company: co._id });
    expect(s.body.versions[0].id).toBe(v1.id);
  });
});

/* ═══ 9 · ATOMICITY — STATE AND EVIDENCE, OR NEITHER ═════════════════════ */

describe("a transition and its evidence commit together", () => {
  /** Make the evidence write fail, once, at the moment it is attempted. */
  const breakEvidence = () => jest.spyOn(CostingTransition, "create")
    .mockRejectedValue(new Error("evidence store unavailable"));

  test("a failed submission evidence write leaves the version a Draft", async () => {
    const { co, me, costingId, version } = await calculated("AtomicSubmit");
    breakEvidence();

    const r = await submit(me, co, costingId, version.id);
    expect(r.status).toBe(500);

    jest.restoreAllMocks();
    /* The first version saved IN_REVIEW and wrote the record afterwards, so
       this left a version in review that nobody could be shown to have
       submitted — a best-effort audit write described as evidence. */
    const after = await CostingVersion.findById(version.id).lean();
    expect(after.status).toBe("DRAFT");
    expect(after.lifecycle?.submittedAt).toBeFalsy();
    expect(await CostingTransition.countDocuments({ versionId: version.id })).toBe(0);

    /* And a retry, with the store working, still succeeds. */
    const ok = await submit(me, co, costingId, version.id, {}, newKey());
    expect(ok.status).toBe(200);
    expect(versionOf(ok.body, version.id).status).toBe("IN_REVIEW");
  });

  test("a failed approval evidence write publishes nothing", async () => {
    const { co, me, costingId, version } = await calculated("AtomicApprove");
    await submit(me, co, costingId, version.id);
    breakEvidence();

    const r = await approve(me, co, costingId, version.id);
    expect(r.status).toBe(500);

    jest.restoreAllMocks();
    const after = await CostingVersion.findById(version.id).lean();
    /* No half-approved answer: not the status, not the pointer, not a
       published price. */
    expect(after.status).toBe("IN_REVIEW");
    const parent = await Costing.findById(costingId).lean();
    expect(parent.approvedVersionId).toBeNull();
    expect(await CostingTransition.countDocuments({ versionId: version.id, kind: "APPROVE" })).toBe(0);

    /* And the retry finishes the approval consistently, rather than being
       refused as "already approved". */
    const ok = await approve(me, co, costingId, version.id, { note: NOTE }, newKey());
    expect(ok.status).toBe(200);
    expect((await Costing.findById(costingId).lean()).approvedVersionNumber).toBe(version.versionNumber);
  });

  test("a failure at the supersede boundary leaves the OLD answer standing", async () => {
    const { co, me, costingId, seeded, version: v1 } = await calculated("SupersedeFail");
    await submit(me, co, costingId, v1.id);
    await approve(me, co, costingId, v1.id);
    await widenBrief(seeded);
    const v2 = (await calculate(me, co, costingId)).body.versions[0];
    await submit(me, co, costingId, v2.id);

    /* Break the write that steps the OLD version down. */
    const realSave = CostingVersion.prototype.save;
    jest.spyOn(CostingVersion.prototype, "save").mockImplementation(function patched(...args) {
      if (this.status === "SUPERSEDED") return Promise.reject(new Error("supersede failed"));
      return realSave.apply(this, args);
    });

    expect((await approve(me, co, costingId, v2.id, { note: "Second approval." })).status).toBe(500);
    jest.restoreAllMocks();

    /* Exactly one approved version, and it is the original answer — never
       none, and never two. */
    const approved = await CostingVersion.find({ costingId, status: "APPROVED" }).lean();
    expect(approved).toHaveLength(1);
    expect(String(approved[0]._id)).toBe(String(v1.id));
    expect((await Costing.findById(costingId).lean()).approvedVersionNumber).toBe(v1.versionNumber);
  });

  test("a failure at the parent-pointer boundary publishes nothing", async () => {
    const { co, me, costingId, version } = await calculated("PointerFail");
    await submit(me, co, costingId, version.id);
    jest.spyOn(Costing.prototype, "save").mockRejectedValue(new Error("pointer write failed"));

    expect((await approve(me, co, costingId, version.id)).status).toBe(500);
    jest.restoreAllMocks();

    const after = await CostingVersion.findById(version.id).lean();
    expect(after.status).toBe("IN_REVIEW");
    expect(await CostingVersion.countDocuments({ costingId, status: "APPROVED" })).toBe(0);
    expect(await CostingTransition.countDocuments({ versionId: version.id, kind: "APPROVE" })).toBe(0);
  });
});

/* ═══ 10 · TWO CONCURRENT FIRST APPROVALS ════════════════════════════════ */

describe("concurrency", () => {
  test("two first approvals of different versions produce one approved version", async () => {
    const { co, me, costingId, seeded, version: v1 } = await calculated("RaceFirst");
    await widenBrief(seeded);
    const v2 = (await calculate(me, co, costingId)).body.versions[0];
    await submit(me, co, costingId, v1.id);
    await submit(me, co, costingId, v2.id);

    /* Nothing is approved yet, so there is no previously approved row for
       these two to contend over — without a transaction they would both
       succeed and the costing would have two current commercial answers. */
    const [a, b] = await Promise.all([
      approve(me, co, costingId, v1.id, { note: "Approving version one." }),
      approve(me, co, costingId, v2.id, { note: "Approving version two." }),
    ]);

    /* THE GUARANTEE, however the two races physically resolve: never two
       current commercial answers. Without the transaction both would approve
       and this would be 2. It is 1 whether the two conflicted (one lost the
       race outright) OR serialised (the first approved, then the newer one
       superseded it) — both are safe, and the count is what proves it. */
    const approved = await CostingVersion.find({ costingId, status: "APPROVED" }).lean();
    expect(approved).toHaveLength(1);

    /* At least one caller was told it worked. The other was NOT told it worked
       while a second approved answer also stood — asserting the loser is
       refused (>=400) is too strict: a legitimate serialised supersede returns
       200 to both, and the single approved row above is the real invariant. */
    expect([a.status, b.status]).toContain(200);

    const parent = await Costing.findById(costingId).lean();
    expect(String(parent.approvedVersionId)).toBe(String(approved[0]._id));

    /* And the version the parent does NOT point at is never a second live
       approval — it either lost the race (still IN_REVIEW) or was superseded. */
    const others = await CostingVersion
      .find({ costingId, _id: { $ne: approved[0]._id } })
      .lean();
    for (const v of others) expect(v.status).not.toBe("APPROVED");
  });

  test("the same approval sent twice at once approves once", async () => {
    const { co, me, costingId, version } = await calculated("RaceSame");
    await submit(me, co, costingId, version.id);
    const key = newKey();

    const [a, b] = await Promise.all([
      approve(me, co, costingId, version.id, { note: NOTE }, key),
      approve(me, co, costingId, version.id, { note: NOTE }, key),
    ]);
    expect([a.status, b.status].every((s) => s === 200 || s === 409)).toBe(true);
    expect(await CostingTransition.countDocuments({ versionId: version.id, kind: "APPROVE" })).toBe(1);
    expect(await CostingVersion.countDocuments({ costingId, status: "APPROVED" })).toBe(1);
  });
});

/* ═══ 11 · THE DURABLE RECEIPT ═══════════════════════════════════════════ */

describe("idempotency that survives its bookkeeping", () => {
  /** What expiry looks like: the temporary row is gone, the receipt is not. */
  const forgetTemporaryRecords = async () => {
    const SpIdempotencyRecord = require("../../models/CMS_Models/StorePurchase/SpIdempotencyRecord");
    await SpIdempotencyRecord.deleteMany({});
  };

  test("a Submit key cannot replay an Approve", async () => {
    const { co, me, costingId, version } = await calculated("KeyCrossover");
    const key = newKey();
    expect((await submit(me, co, costingId, version.id, { note: "Ready." }, key)).status).toBe(200);
    await forgetTemporaryRecords();

    /* The same raw key, presented for a different operation. The first
       version looked up `{companyId, versionId, key}` alone, found the
       Submit receipt, and "replayed" an approval into a version nobody had
       approved. */
    const r = await approve(me, co, costingId, version.id, { note: NOTE }, key);
    expect(r.status).toBe(200);
    expect(r.body.replayed).toBe(false);
    expect(r.body.transition.kind).toBe("APPROVE");

    const kinds = await CostingTransition.find({ versionId: version.id }).lean();
    expect(kinds.map((k) => k.kind).sort()).toEqual(["APPROVE", "SUBMIT"]);
  });

  test("a changed body with a reused key conflicts after the temporary record is gone", async () => {
    const { co, me, costingId, version } = await calculated("ExpiredChange");
    await submit(me, co, costingId, version.id);
    const key = newKey();
    expect((await approve(me, co, costingId, version.id, { note: "First stated reason." }, key)).status).toBe(200);

    await forgetTemporaryRecords();

    /* With the bookkeeping row gone, only the durable receipt can tell that
       this is a different request — and answering it with the first one's
       result would put words on the record the approver never used. */
    const changed = await approve(me, co, costingId, version.id, { note: "An entirely different reason." }, key);
    expect(changed.status).toBe(409);
    expect(changed.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    const stored = await CostingTransition.findOne({ versionId: version.id, kind: "APPROVE" }).lean();
    expect(stored.note).toBe("First stated reason.");
  });

  test("the identical request replays after the temporary record is gone", async () => {
    const { co, me, costingId, version } = await calculated("ExpiredSame");
    const key = newKey();
    expect((await submit(me, co, costingId, version.id, { note: "Ready." }, key)).status).toBe(200);
    await forgetTemporaryRecords();

    const again = await submit(me, co, costingId, version.id, { note: "Ready." }, key);
    expect(again.status).toBe(200);
    expect(again.body.replayed).toBe(true);
    expect(await CostingTransition.countDocuments({ versionId: version.id, kind: "SUBMIT" })).toBe(1);
  });

  test("a replay returns current server truth, not a stale echo", async () => {
    const { co, me, costingId, version } = await calculated("ReplayTruth");
    await submit(me, co, costingId, version.id);
    const key = newKey();
    await approve(me, co, costingId, version.id, { note: NOTE }, key);
    await forgetTemporaryRecords();

    const replay = await approve(me, co, costingId, version.id, { note: NOTE }, key);
    expect(replay.body.replayed).toBe(true);
    /* The intended operation… */
    expect(replay.body.transition.kind).toBe("APPROVE");
    /* …and the state as it is NOW, re-read and re-serialised rather than
       reconstructed from what the transition once said. */
    expect(versionOf(replay.body, version.id).status).toBe("APPROVED");
    expect(replay.body.costing.approvedVersion.id).toBe(version.id);
    expect(versionOf(replay.body, version.id).output.approved).toBe(true);
  });
});

/* ═══ 12 · EVERY SCENARIO MUST BE COMMERCIALLY COMPLETE ══════════════════ */

describe("what may be published", () => {
  /** Damage one scenario's frozen commercial result, in place. */
  const damage = (id, mutate) => CostingVersion.collection.findOneAndUpdate(
    { _id: new mongoose.Types.ObjectId(String(id)) }, mutate,
  );

  test("one unpriced quantity blocks the whole approval", async () => {
    const { co, me, costingId, version } = await calculated("Partial");
    await submit(me, co, costingId, version.id);
    /* The raw driver, deliberately — the model refuses this, which is the
       point: this is damage the application cannot cause and the check must
       still catch. */
    await damage(version.id, { $unset: { "scenarios.1.floor.floorPriceMinor": "" } });

    const r = await approve(me, co, costingId, version.id);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("COSTING_FROZEN_FACTS_INCOMPLETE");
    expect(r.body.error.details.problems[0])
      .toMatchObject({ scenario: "q2000", reason: "FLOOR_PRICE_MISSING" });

    /* Approval publishes ALL the breaks, so a partial one publishes NOTHING.
       An empty price break reads on the Sales side as "priced at nothing". */
    expect(await CostingVersion.countDocuments({ costingId, status: "APPROVED" })).toBe(0);
  });

  test("a missing unit cost blocks it too — a price with nothing behind it", async () => {
    const { co, me, costingId, version } = await calculated("NoCost");
    await submit(me, co, costingId, version.id);
    await damage(version.id, { $unset: { "scenarios.0.unitCostMinor": "" } });

    const r = await approve(me, co, costingId, version.id);
    expect(r.status).toBe(400);
    expect(r.body.error.details.problems.some((p) => p.reason === "UNIT_COST_MISSING")).toBe(true);
  });

  test("a version priced against another currency's rules is refused", async () => {
    const { co, me, costingId, version } = await calculated("Currency");
    await submit(me, co, costingId, version.id);
    /* A price carries NO currency of its own — `priceSchema` has margins and
       an integer, nothing more. The only inconsistency available is the
       version disagreeing with the policy it was priced against, which would
       mean these margins were the rules for different money.

       My first attempt set `scenarios.0.prices.target.currency`, a field that
       does not exist, and the check read it — so both were dead and the test
       passed against an undefined value. */
    await damage(version.id, { $set: { "policySnapshot.baseCurrency": "USD" } });

    const r = await approve(me, co, costingId, version.id);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("COSTING_FROZEN_FACTS_INCOMPLETE");
    expect(r.body.error.details.problems.some((p) => p.reason === "CURRENCY_MISMATCH")).toBe(true);
    expect(await CostingVersion.countDocuments({ costingId, status: "APPROVED" })).toBe(0);
  });

  test("a genuine zero is a price, and is published", async () => {
    const { co, me, costingId, version } = await calculated("Zero");
    await submit(me, co, costingId, version.id);
    /* Missing is not zero — and zero is not missing. A policy may permit it. */
    await damage(version.id, { $set: { "scenarios.0.floor.floorPriceMinor": 0 } });

    const r = await approve(me, co, costingId, version.id);
    expect(r.status).toBe(200);
    const br = versionOf(r.body, version.id).output.quantityBreaks.find((b) => b.key === "q500");
    expect(br.floorPriceMinor).toBe(0);
  });

  test("an unsafe integer is refused — a price that cannot be summed is not a price", async () => {
    const { co, me, costingId, version } = await calculated("Unsafe");
    await submit(me, co, costingId, version.id);
    await damage(version.id, { $set: { "scenarios.0.floor.floorPriceMinor": 9007199254740993 } });

    const r = await approve(me, co, costingId, version.id);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("COSTING_FROZEN_FACTS_INCOMPLETE");
  });
});

/* ═══ 13 · WHAT HAPPENS WHERE THERE ARE NO TRANSACTIONS ══════════════════ */

describe("a deployment without transaction support", () => {
  /** Exactly what a standalone mongod does: hand out a session, then refuse. */
  const noTransactions = () => jest.spyOn(mongoose, "startSession").mockResolvedValue({
    startTransaction() {},
    commitTransaction: async () => {},
    abortTransaction: async () => {},
    endSession() {},
    /* The driver refuses on the first write inside the transaction. */
    id: null,
    inTransaction: () => true,
  });

  test("approval is refused before any write, with a retryable code", async () => {
    const { co, me, costingId, version } = await calculated("NoTxn");
    await submit(me, co, costingId, version.id);

    /* Make the first write inside the transaction fail the way a standalone
       does. Nothing is written, so there is no partial commercial state — a
       costing that cannot be approved is a visible problem somebody fixes,
       where a half-approved one is not. */
    jest.spyOn(CostingVersion.prototype, "save").mockImplementation(() => Promise.reject(
      new Error("Transaction numbers are only allowed on a replica set member or mongos"),
    ));

    const r = await approve(me, co, costingId, version.id);
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe("COSTING_APPROVAL_TRANSACTION_REQUIRED");

    jest.restoreAllMocks();
    expect((await CostingVersion.findById(version.id).lean()).status).toBe("IN_REVIEW");
    expect(await CostingVersion.countDocuments({ costingId, status: "APPROVED" })).toBe(0);
    expect(await CostingTransition.countDocuments({ versionId: version.id, kind: "APPROVE" })).toBe(0);
  });

  test("submission is refused the same way, and stays a Draft", async () => {
    const { co, me, costingId, version } = await calculated("NoTxnSubmit");
    jest.spyOn(CostingVersion.prototype, "save").mockImplementation(() => Promise.reject(
      new Error("Transactions are not supported by this deployment"),
    ));

    const r = await submit(me, co, costingId, version.id);
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe("COSTING_APPROVAL_TRANSACTION_REQUIRED");

    jest.restoreAllMocks();
    expect((await CostingVersion.findById(version.id).lean()).status).toBe("DRAFT");
  });

  test("a session that cannot be opened at all is refused too", async () => {
    const { co, me, costingId, version } = await calculated("NoSession");
    jest.spyOn(mongoose, "startSession").mockResolvedValue(null);

    const r = await submit(me, co, costingId, version.id);
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe("COSTING_APPROVAL_TRANSACTION_REQUIRED");
    jest.restoreAllMocks();
    expect((await CostingVersion.findById(version.id).lean()).status).toBe("DRAFT");
  });
});

/* ═══ 14 · THE RECEIPT INDEX ═════════════════════════════════════════════ */

describe("the durable receipt is unique per operation", () => {
  const row = (over = {}) => ({
    companyId: new mongoose.Types.ObjectId(),
    costingId: new mongoose.Types.ObjectId(),
    versionId: new mongoose.Types.ObjectId(),
    versionNumber: 1, kind: "SUBMIT", fromStatus: "DRAFT", toStatus: "IN_REVIEW",
    actorId: "a", at: new Date(),
    operation: "SUBMIT", idempotencyKey: "key-1", target: "t", requestHash: "h",
    ...over,
  });

  test("one key cannot be inserted twice for the same operation", async () => {
    await CostingTransition.init();
    const first = row();
    await CostingTransition.create(first);
    /* The transaction is what normally serialises this; the index is what
       makes it impossible rather than unlikely — and it is the last defence
       if two requests ever reach the write on different paths. */
    await expect(CostingTransition.create(row({
      companyId: first.companyId, costingId: first.costingId, versionId: first.versionId,
    }))).rejects.toThrow(/duplicate key/i);
  });

  test("the same key on a different operation is a different receipt", async () => {
    await CostingTransition.init();
    const first = row();
    await CostingTransition.create(first);
    /* Submit and Approve are two actions. Sharing an index entry would mean
       one could replay the other, which is the defect this binding fixes. */
    const second = await CostingTransition.create(row({
      companyId: first.companyId, costingId: first.costingId, versionId: first.versionId,
      kind: "APPROVE", operation: "APPROVE", fromStatus: "IN_REVIEW", toStatus: "APPROVED",
    }));
    expect(second.operation).toBe("APPROVE");
  });

  test("keyless side effects never collide", async () => {
    await CostingTransition.init();
    const base = { companyId: new mongoose.Types.ObjectId(), costingId: new mongoose.Types.ObjectId() };
    /* A SUPERSEDE is a consequence nobody requested — it has no key and no
       operation, and a partial index must not fold every one of them into a
       single entry. */
    for (let i = 0; i < 3; i += 1) {
      await CostingTransition.create(row({
        ...base, versionId: new mongoose.Types.ObjectId(),
        kind: "SUPERSEDE", fromStatus: "APPROVED", toStatus: "SUPERSEDED",
        operation: "", idempotencyKey: "", target: "", requestHash: "",
      }));
    }
    expect(await CostingTransition.countDocuments({ ...base, kind: "SUPERSEDE" })).toBe(3);
  });
});
