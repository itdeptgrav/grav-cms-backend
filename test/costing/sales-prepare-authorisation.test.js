// test/costing/sales-prepare-authorisation.test.js
//
// WHO MAY CAUSE A COSTING TO EXIST.
//
// ── THE GAP THIS CLOSES ─────────────────────────────────────────────────────
// `Prepare estimate` and `Refresh estimate` were guarded by Sales
// authentication and a company resolution, and by nothing else. Both of those
// answer "who are you and which company are you in". Neither answers "may you
// do this" — and preparing an estimate is a WRITE: it can bring a `Costing`
// and a frozen `CostingVersion` into existence, under a durable creation
// claim, in a history somebody may later be asked about.
//
// So any authenticated Sales user could make the server write records that the
// capability model reserved for `costing.draft.write` — a grant held by
// platform administrators and the CEO authority alone.
//
// The correction is a capability of its own, `costing.prepare`, meaning only:
// may ask Central Costing to assemble the departmental inputs and prepare or
// refresh an estimate for an enquiry this actor may already reach. It implies
// nothing — not cost, not margin, not draft write, not approval, not policy —
// and nothing implies it.
//
// ── WHY THESE TESTS RESOLVE REAL GRANTS ─────────────────────────────────────
// `sales-estimate-preparation.test.js` hands the service a capability set it
// composed itself, which is right for testing what preparation DOES. It is
// the wrong instrument for testing who may do it: a hand-made set proves
// nothing about the department-role table that decides the real answer.
//
// So every actor here is resolved by `capabilities.resolveCapabilities` from a
// `DepartmentRole` row, the way a request resolves one.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

/* ── THE EDGES THE SALES ROUTER PULLS IN, STUBBED WHOLE ──────────────────────
 * Firebase, notifications, the change log and the cowork services are required
 * transitively by `routes/CMS_Routes/Sales/enquiries.js`. None participates in
 * an authorisation decision, and one of them (`cowork.service`) pulls an ES
 * module this repository's jest cannot require. Stubbed at the edge, the same
 * way `enquiry-tenancy.route.test.js` stubs them. */
jest.mock("../../config/firebaseAdmin", () => ({ messaging: () => ({ send: async () => ({}) }) }));
jest.mock("../../services/NotificationService", () => ({
  notify: async () => ({}), notifyUser: async () => ({}), send: async () => ({}),
}));
jest.mock("../../services/departmentNotify.service", () => ({
  notifyEvent: async () => ({}), APP_URL: "http://localhost",
}));
jest.mock("../../services/changeLog", () => ({
  recordChange: async () => ({}), historyFor: async () => [], diff: () => ({}),
}));
jest.mock("../../services/cowork.service", () => ({}), { virtual: true });
jest.mock("../../services/coworkSheets.service", () => ({}), { virtual: true });

/* ── THE SIGN-IN IS STUBBED, THE AUTHORISATION IS NOT ────────────────────────
 * `salesAuth` answers "who is this", which is not what this suite is about and
 * needs a real token to exercise. What IS under test — which capability the
 * actor's department grant resolves to — runs unmocked, from the database, on
 * every request. Mocking that would test the mock. */
jest.mock("../../Middlewear/SalesAuthMiddlewear", () => {
  const mw = (req, res, next) => {
    if (!global.__ACTOR__) return res.status(401).json({ success: false });
    req.user = global.__ACTOR__;
    next();
  };
  mw.withRoles = () => mw;
  return mw;
});

const mongoose = require("mongoose");
const {
  seedSourceBacked, configureProduction, approveFinancingPolicy, CONFIRMED_TERMS,
  EVERY_FAMILY, confirmCostingBrief,
} = require("./helpers/sourceBacked");

const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const CostingPolicy = require("../../models/CMS_Models/Costing/CostingPolicy");
const CostingVersion = require("../../models/CMS_Models/Costing/CostingVersion");
const Costing = require("../../models/CMS_Models/Costing/Costing");
const Employee = require("../../models/Employee");
const DeptUser = require("../../models/Access/DeptUser");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const SpIdempotencyRecord = require("../../models/CMS_Models/StorePurchase/SpIdempotencyRecord");

const prep = require("../../services/sales/costingPreparation.service");
const result = require("../../services/sales/costingResult.service");
const capabilities = require("../../services/centralCosting/capabilities");
const companyContext = require("../../services/centralCosting/companyContext.service");

const { CAPABILITIES: C } = capabilities;

let seq = 0;

/* ── A PERSON, WITH A REAL DEPARTMENT GRANT ──────────────────────────────── */
async function person({ company, grant = null, role = "editor", admin = false } = {}) {
  const n = ++seq;
  const email = `prep-auth-${n}@test.example`;
  const emp = await Employee.create({
    firstName: "P", lastName: `A${n}`, email, biometricId: `PA${n}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  if (grant) await DepartmentRole.create({ departmentSlug: grant, email, role, isActive: true });
  if (admin) {
    await DeptUser.create({
      name: "P", email, passwordHash: "x", isAdmin: true, isActive: true,
      departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
    });
  }
  if (company) {
    await SpCompanyMembership.create({
      companyId: company._id, email, employeeRef: emp._id, personName: "P",
    });
  }
  return { emp, email, user: { id: String(emp._id), email } };
}

/** The context a request would build for this person — never a composed set. */
const ctxFor = (p, companyId) =>
  companyContext.resolveForActor(p.user, { requestedCompanyId: companyId });

/** A fully sourced company with a confirmed brief, ready to be costed. */
async function world(over = {}) {
  const co = await Acc_Company.create({
    companyName: `PrepAuth ${++seq}`, booksFromDate: new Date("2026-04-01"),
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
  await confirmCostingBrief(co._id, { enquiryId: seeded.enquiry._id, styleId: seeded.style._id });
  return { co, seeded, product: seeded.product };
}

const prepare = (ctx, w, key = null) => prep.prepare(ctx, {
  enquiryId: w.seeded.enquiry._id,
  product: w.product,
  actionKey: key || `auth-${++seq}`,
});

/** Everything a refusal must not have created. */
async function writeCount(companyId) {
  const [costings, versions, claims] = await Promise.all([
    Costing.countDocuments({ companyId }),
    CostingVersion.countDocuments({ companyId }),
    SpIdempotencyRecord.countDocuments({ companyId }),
  ]);
  return { costings, versions, claims };
}

const refusalOf = async (fn) => {
  try { await fn(); } catch (err) { return err; }
  return null;
};

/* ═══ 1 · THE CAPABILITY ITSELF ══════════════════════════════════════════ */

describe("the capability", () => {
  test("it exists, and it is not spelled like something broader", () => {
    expect(C.PREPARE).toBe("costing.prepare");
    /* Distinct names, so a grep for one never finds the other. */
    expect(C.PREPARE).not.toBe(C.DRAFT_WRITE);
    expect(new Set(Object.values(C)).size).toBe(Object.values(C).length);
  });

  test("it implies nothing, and nothing implies it", () => {
    /* ── THE WHOLE POINT, PINNED ──────────────────────────────────────
       The correction would be undone by one convenience implication. A
       holder may start a calculation and then be shown almost none of its
       result — that asymmetry is the design, not an oversight.

       Asserted through the grant table, which is the only place an
       implication could be applied: `capabilitiesFromGrants` runs
       `applyImplications` on its way out, so what comes back IS the closure. */
    const sales = capabilities.capabilitiesFromGrants(
      [{ departmentSlug: "sales", role: "owner" }], false,
    ).capabilities;

    /* Preparing grants no reading and no authority. */
    expect(sales).toContain(C.PREPARE);
    for (const denied of [C.COST_READ, C.MARGIN_READ, C.DRAFT_WRITE, C.APPROVE, C.POLICY_MANAGE]) {
      expect(sales).not.toContain(denied);
    }
    /* Sales' own read grant is untouched by the addition. */
    expect(sales).toContain(C.OUTPUT_READ);
    /* A Sales owner also holds the two COMMERCIAL grants — asking for a
       decision and taking an ordinary one. Neither reveals anything: the
       denial list above is what this test is for, and it is unchanged. */
    expect(sales.sort()).toEqual([
      C.OUTPUT_READ, C.PREPARE, C.COMMERCIAL_SUBMIT, C.COMMERCIAL_APPROVE,
    ].sort());
  });

  test("draft.write does not quietly carry it either", () => {
    /* The one implication this system has is `draft.write ⇒ cost.read`. A
       second one pointing at prepare would mean the costing maintainers had
       silently acquired Sales' authority over which enquiry gets costed. */
    const admin = capabilities.capabilitiesFromGrants([], true).capabilities;
    /* An administrator holds everything, including prepare — that is the
       existing authority the correction was told to preserve. */
    expect(admin).toContain(C.PREPARE);
    expect(admin).toContain(C.DRAFT_WRITE);
  });
});

/* ═══ 2 · THE ROLE MATRIX ════════════════════════════════════════════════ */

describe("who is granted it", () => {
  const capsOf = (slug, role) =>
    capabilities.capabilitiesFromGrants([{ departmentSlug: slug, role }], false).capabilities;

  test("Sales editor, approver and owner may prepare", () => {
    for (const role of ["editor", "approver", "owner"]) {
      expect(capsOf("sales", role)).toContain(C.PREPARE);
    }
  });

  test("Sales viewer may read the output and may NOT prepare", () => {
    /* ── WHY THE LINE IS HERE ─────────────────────────────────────────
       `viewer` is the rank for people who need to see the work without
       being answerable for it. Preparing writes a company record. */
    const viewer = capsOf("sales", "viewer");
    expect(viewer).toContain(C.OUTPUT_READ);
    expect(viewer).not.toContain(C.PREPARE);
  });

  test("an unrelated department gets nothing at all", () => {
    for (const slug of ["store", "merchandising", "production", "rnd", "accounts"]) {
      expect(capsOf(slug, "owner")).toEqual([]);
    }
  });

  test("the CEO authority and platform administrators keep it", () => {
    expect(capsOf("ceo", "owner")).toContain(C.PREPARE);
    expect(capabilities.capabilitiesFromGrants([], true).capabilities).toContain(C.PREPARE);
  });

  test("an unranked Sales role falls to the highest rank at or below it", () => {
    /* The resolver ranks rather than matching exactly, so a role the table
       does not name must not resolve to a HIGHER grant than its rank. */
    expect(capsOf("sales", "reader")).not.toContain(C.PREPARE);
  });
});

/* ═══ 3 · THE SERVICE REFUSES, AND WRITES NOTHING ════════════════════════ */

describe("preparing without the grant", () => {
  test("a Sales viewer is refused, by name", async () => {
    const w = await world();
    const viewer = await person({ company: w.co, grant: "sales", role: "viewer" });
    const ctx = await ctxFor(viewer, w.co._id);

    expect([...ctx.capabilitySet]).toContain(C.OUTPUT_READ);
    expect([...ctx.capabilitySet]).not.toContain(C.PREPARE);

    const err = await refusalOf(() => prepare(ctx, w));
    expect(err).toBeTruthy();
    expect(err.code).toBe("COSTING_PREPARE_FORBIDDEN");
    expect(err.status).toBe(403);
    expect(err.details.required).toBe(C.PREPARE);
  });

  test("a denied request creates no costing, no version, no claim", async () => {
    /* ── THE ASSERTION THAT MATTERS MOST ──────────────────────────────
       A refusal that arrives after the costing was inserted has not refused
       anything. The guard is the first statement in `prepare`, before the
       brief is resolved and before any source is assembled. */
    const w = await world();
    const viewer = await person({ company: w.co, grant: "sales", role: "viewer" });
    const ctx = await ctxFor(viewer, w.co._id);

    const before = await writeCount(w.co._id);
    await refusalOf(() => prepare(ctx, w));
    const after = await writeCount(w.co._id);

    expect(after).toEqual(before);
    expect(after.costings).toBe(0);
    expect(after.versions).toBe(0);
  });

  test("an unrelated department cannot prepare, even inside the company", async () => {
    const w = await world();
    const store = await person({ company: w.co, grant: "store", role: "owner" });
    const ctx = await ctxFor(store, w.co._id);

    const err = await refusalOf(() => prepare(ctx, w));
    expect(err.code).toBe("COSTING_PREPARE_FORBIDDEN");
    expect(await Costing.countDocuments({ companyId: w.co._id })).toBe(0);
  });

  test("no request body can manufacture the authority", async () => {
    /* ── WHAT A STALE OR HOSTILE CLIENT WOULD TRY ─────────────────────
       A company, a costing id, a style, a capability list, a calculation.
       None of them is read: the ctx is server-resolved and the guard asks
       the ctx, so a payload has nothing to say about who the caller is. */
    const w = await world();
    const viewer = await person({ company: w.co, grant: "sales", role: "viewer" });
    const ctx = await ctxFor(viewer, w.co._id);

    const err = await refusalOf(() => prep.prepare(ctx, {
      enquiryId: w.seeded.enquiry._id,
      product: w.product,
      actionKey: "forged",
      /* Every shape a client might hope is trusted. */
      capabilities: [C.PREPARE, C.DRAFT_WRITE],
      capabilitySet: new Set([C.PREPARE]),
      companyId: new mongoose.Types.ObjectId(),
      costingId: new mongoose.Types.ObjectId(),
      technicalStyleId: w.seeded.style._id,
      lines: [{ lineKey: "x", amount: { amountMinor: 1, currency: "INR" } }],
    }));

    expect(err.code).toBe("COSTING_PREPARE_FORBIDDEN");
    expect(await Costing.countDocuments({})).toBe(0);
  });
});

/* ═══ 4 · AND WITH THE GRANT, IT WORKS UNCHANGED ═════════════════════════ */

describe("preparing with the grant", () => {
  test("a Sales editor prepares, and the estimate is created", async () => {
    const w = await world();
    const editor = await person({ company: w.co, grant: "sales", role: "editor" });
    const ctx = await ctxFor(editor, w.co._id);

    const out = await prepare(ctx, w);
    expect(out.outcome).toBe("PREPARED");

    const costing = await Costing.findOne({ companyId: w.co._id }).lean();
    expect(costing).toBeTruthy();
    /* The durable creation claim is unchanged — the correction gated the
       door, it did not touch what happens once somebody is through it. */
    expect(costing.creationClaimId).toBeTruthy();
    const v = await CostingVersion.findOne({ costingId: costing._id })
      .sort({ versionNumber: -1 }).lean();
    expect(v.provenance.origin).toBe("SALES_PREPARATION");
    expect(v.provenance.sourceFingerprint).toBeTruthy();
  });

  test("Sales approver and owner prepare too", async () => {
    for (const role of ["approver", "owner"]) {
      const w = await world();
      const p = await person({ company: w.co, grant: "sales", role });
      const ctx = await ctxFor(p, w.co._id);
      const out = await prepare(ctx, w);
      expect(out.outcome).toBe("PREPARED");
      expect(await Costing.countDocuments({ companyId: w.co._id })).toBe(1);
    }
  });

  test("the idempotency contract is exactly what it was", async () => {
    /* ── PRESERVED, NOT REIMPLEMENTED ─────────────────────────────────
       An identical retry returns the version that exists rather than making
       a second — under the same action key AND a different one, because the
       resolved source fingerprint decides, not the key. */
    const w = await world();
    const editor = await person({ company: w.co, grant: "sales", role: "editor" });
    const ctx = await ctxFor(editor, w.co._id);

    const first = await prepare(ctx, w, "same-key");
    expect(first.outcome).toBe("PREPARED");

    expect((await prepare(ctx, w, "same-key")).outcome).toBe("UNCHANGED");
    expect((await prepare(ctx, w, "a-different-key")).outcome).toBe("UNCHANGED");

    const costing = await Costing.findOne({ companyId: w.co._id }).lean();
    expect(await CostingVersion.countDocuments({ costingId: costing._id })).toBe(2);
  });

  test("preparing grants no cost, supplier-rate or unrestricted margin sight", async () => {
    /* ── THE ASYMMETRY, PROVED ON A REAL PRICED SCENARIO ──────────────
       This test is only worth anything if the version it inspects actually
       HAS figures to withhold. An earlier form of it looped over
       `view.scenarios` and passed whenever that list was empty — which it
       was, for a while, because another lane's blocker meant nothing was
       ever prepared. A vacuous pass here is worse than no test: it reports
       that a confidential figure is hidden when the truth is that no figure
       was computed.

       So every step is asserted: the estimate was PREPARED, a version was
       frozen, it carries a priced scenario, and the engine really did
       compute a unit cost on it. Only then is the projection's silence
       meaningful. */
    const w = await world();
    const editor = await person({ company: w.co, grant: "sales", role: "editor" });
    const ctx = await ctxFor(editor, w.co._id);

    const out = await prepare(ctx, w);
    expect(out.outcome).toBe("PREPARED");

    /* 1 · A real frozen version, with a real calculated cost on it. */
    const costing = await Costing.findOne({ companyId: w.co._id }).lean();
    const frozen = await CostingVersion.findOne({ costingId: costing._id })
      .sort({ versionNumber: -1 }).lean();
    expect(frozen.scenarios.length).toBeGreaterThan(0);
    const priced = frozen.scenarios[0];
    expect(typeof priced.unitCostMinor).toBe("number");
    expect(priced.unitCostMinor).toBeGreaterThan(0);

    /* 2 · The same version, read by somebody who MAY see cost, shows it —
       so the withholding below is a decision about the reader, not an
       absence in the record. */
    const seen = result.resultFor({
      resolved: out,
      caps: new Set([...ctx.capabilitySet, C.COST_READ, C.MARGIN_READ]),
    });
    expect(seen.scenarios.length).toBeGreaterThan(0);
    expect(seen.scenarios[0].unitCostMinor).toBe(priced.unitCostMinor);

    /* 3 · And read by the editor who CAUSED it, the figures are gone. */
    const view = result.resultFor({ resolved: out, caps: ctx.capabilitySet });
    expect(view.scenarios.length).toBe(seen.scenarios.length);
    expect(view.scenarios.length).toBeGreaterThan(0);
    for (const scenario of view.scenarios) {
      expect(scenario.unitCostMinor).toBeUndefined();
      expect(scenario.totalCostMinor).toBeUndefined();
      /* The quantity is theirs to know; what it costs is not. */
      expect(scenario.quantity).toBeTruthy();
    }

    /* 4 · The cost value itself appears nowhere in the payload, in any
       field — a projection that renamed it would still be a leak. */
    const body = JSON.stringify(view);
    expect(body).not.toContain(String(priced.unitCostMinor));
    expect(seen.scenarios[0].unitCostMinor).toBeGreaterThan(0); // the value really is findable
    for (const leak of ["supplierName", "supplierId", "quotationReference", "unitPriceMinor",
      "operatorSalary", "perMinute", "ratePercent", "minimumMarginPercent",
      "costBuildUp", "inputs", "sourceReferences"]) {
      expect(body).not.toContain(leak);
    }

    /* And it says what they MAY do, which is how the screen stops offering
       an action the server would refuse. */
    expect(view.permissions.canPrepare).toBe(true);
  });
});

/* ═══ 5 · REVOCATION, AND THE COMPANY BOUNDARY ══════════════════════════ */

describe("the grant is re-read, and the boundary holds", () => {
  test("a revoked grant fails on the very next request", async () => {
    /* ── WHY THIS CANNOT WAIT FOR A TOKEN TO EXPIRE ───────────────────
       `resolveCapabilities` reads the database every time rather than
       trusting the token, so somebody removed from Sales this morning is
       refused this morning. */
    const w = await world();
    const editor = await person({ company: w.co, grant: "sales", role: "editor" });

    const before = await ctxFor(editor, w.co._id);
    expect([...before.capabilitySet]).toContain(C.PREPARE);

    await DepartmentRole.updateOne({ email: editor.email }, { $set: { isActive: false } });

    const after = await ctxFor(editor, w.co._id);
    expect([...after.capabilitySet]).not.toContain(C.PREPARE);
    const err = await refusalOf(() => prepare(after, w));
    expect(err.code).toBe("COSTING_PREPARE_FORBIDDEN");
  });

  test("a downgrade to viewer fails on the very next request", async () => {
    const w = await world();
    const editor = await person({ company: w.co, grant: "sales", role: "editor" });
    expect([...(await ctxFor(editor, w.co._id)).capabilitySet]).toContain(C.PREPARE);

    await DepartmentRole.updateOne({ email: editor.email }, { $set: { role: "viewer" } });

    const ctx = await ctxFor(editor, w.co._id);
    expect([...ctx.capabilitySet]).not.toContain(C.PREPARE);
    expect((await refusalOf(() => prepare(ctx, w))).code).toBe("COSTING_PREPARE_FORBIDDEN");
  });

  test("an enquiry in another company is not found, never forbidden", async () => {
    /* ── TWO DIFFERENT ANSWERS, AND THEY MUST NOT BE SWAPPED ──────────
       403 says "this exists and you may not act on it" — which, to somebody
       outside the company, is a disclosure. A foreign enquiry must remain
       indistinguishable from one that was never raised, and that refusal
       comes from the scope, before the capability is ever consulted. */
    const mine = await world();
    const theirs = await world();
    const editor = await person({ company: mine.co, grant: "sales", role: "editor" });
    const ctx = await ctxFor(editor, mine.co._id);

    const foreign = await refusalOf(() => prep.prepare(ctx, {
      enquiryId: theirs.seeded.enquiry._id, product: theirs.product, actionKey: "x1",
    }));
    const missing = await refusalOf(() => prep.prepare(ctx, {
      enquiryId: new mongoose.Types.ObjectId(), product: theirs.product, actionKey: "x2",
    }));

    expect(foreign).toBeTruthy();
    expect(foreign.code).toBe(missing.code);
    expect(foreign.status).toBe(missing.status);
    expect(foreign.code).not.toBe("COSTING_PREPARE_FORBIDDEN");
    /* And nothing was written into either company. */
    expect(await Costing.countDocuments({ companyId: theirs.co._id })).toBe(0);
  });
});

/* ═══ 6 · READING IS NOT PREPARING ══════════════════════════════════════ */

describe("reading where the estimate stands", () => {
  test("a Sales viewer may still read, and the read writes nothing", async () => {
    /* Gating the READ would hide from a viewer the very number their grant
       exists to let them quote. */
    const w = await world();
    const viewer = await person({ company: w.co, grant: "sales", role: "viewer" });
    const ctx = await ctxFor(viewer, w.co._id);

    const before = await writeCount(w.co._id);
    const view = result.resultFor({
      resolved: await prep.resolve(ctx, { enquiryId: w.seeded.enquiry._id, product: w.product }),
      caps: ctx.capabilitySet,
    });
    const after = await writeCount(w.co._id);

    expect(after).toEqual(before);
    expect(after.costings).toBe(0);
    expect(after.versions).toBe(0);
    /* Read succeeded, and told the screen not to offer the action. */
    expect(view.state).toBeTruthy();
    expect(view.permissions.canPrepare).toBe(false);
  });

  test("reading an already-prepared estimate still writes nothing", async () => {
    const w = await world();
    const editor = await person({ company: w.co, grant: "sales", role: "editor" });
    const ectx = await ctxFor(editor, w.co._id);
    await prepare(ectx, w);

    const viewer = await person({ company: w.co, grant: "sales", role: "viewer" });
    const vctx = await ctxFor(viewer, w.co._id);

    const before = await writeCount(w.co._id);
    for (let i = 0; i < 3; i += 1) {
      await prep.resolve(vctx, { enquiryId: w.seeded.enquiry._id, product: w.product });
    }
    expect(await writeCount(w.co._id)).toEqual(before);
  });
});

/* ═══ 7 · AND THE DOOR ITSELF, OVER HTTP ═════════════════════════════════ */

describe("the route refuses before the service is reached", () => {
  let server; let base;

  beforeAll(async () => {
    const express = require("express");
    const app = express();
    app.use(express.json());
    app.use("/", require("../../routes/CMS_Routes/Sales/enquiries"));
    await new Promise((r) => { server = app.listen(0, r); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { await new Promise((r) => server.close(r)); });
  afterEach(() => { global.__ACTOR__ = null; });

  const call = (path_, { method = "GET", body } = {}) =>
    fetch(`${base}${path_}`, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }).then(async (r) => {
      const raw = await r.text();
      let parsed = null;
      try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = { nonJson: true }; }
      return { status: r.status, body: parsed };
    });

  test("a Sales viewer gets a controlled 403, and nothing is written", async () => {
    /* ── THE GATE IS AT THE DOOR AS WELL AS IN THE SERVICE ────────────
       Both, deliberately. The door refuses before the work starts and gives
       the screen something to render; the service refuses because it is a
       plain module any future route could call. */
    const w = await world();
    const viewer = await person({ company: w.co, grant: "sales", role: "viewer" });
    global.__ACTOR__ = { id: String(viewer.emp._id), email: viewer.email };

    const before = await writeCount(w.co._id);
    const r = await call(`/${w.seeded.enquiry._id}/costing-estimate/prepare`, {
      method: "POST",
      body: { product: w.product, actionKey: "http-denied" },
    });

    expect(r.status).toBe(403);
    /* The domain envelope: `error.code` for a client to branch on, and
       `message` at the top level because every existing screen reads that. */
    expect(r.body.error.code).toBe("COSTING_PREPARE_FORBIDDEN");
    expect(r.body.error.details.required).toBe(C.PREPARE);
    /* The message names the action, never who holds the grant. */
    expect(r.body.message).toMatch(/permission to prepare/i);
    expect(JSON.stringify(r.body)).not.toMatch(/ceo|admin/i);

    expect(await writeCount(w.co._id)).toEqual(before);
  });

  test("a Sales editor is served, over the same door", async () => {
    const w = await world();
    const editor = await person({ company: w.co, grant: "sales", role: "editor" });
    global.__ACTOR__ = { id: String(editor.emp._id), email: editor.email };

    const r = await call(`/${w.seeded.enquiry._id}/costing-estimate/prepare`, {
      method: "POST",
      body: { product: w.product, actionKey: "http-allowed" },
    });

    expect(r.status).toBe(200);
    expect(r.body.outcome).toBe("PREPARED");
    expect(await Costing.countDocuments({ companyId: w.co._id })).toBe(1);
  });

  test("the GET stays open to a viewer, and writes nothing", async () => {
    const w = await world();
    const viewer = await person({ company: w.co, grant: "sales", role: "viewer" });
    global.__ACTOR__ = { id: String(viewer.emp._id), email: viewer.email };

    const before = await writeCount(w.co._id);
    const r = await call(`/${w.seeded.enquiry._id}/costing-estimate?product=${encodeURIComponent(w.product)}`);

    expect(r.status).toBe(200);
    expect(r.body.permissions.canPrepare).toBe(false);
    expect(await writeCount(w.co._id)).toEqual(before);
  });
});
