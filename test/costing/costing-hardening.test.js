// test/costing/costing-hardening.test.js
//
// Central Costing — Chunk 1 hardening. THE HOLES THE FIRST PASS LEFT.
//
// Each block here corresponds to one defect found by reviewing Chunk 1 rather
// than to a feature: a duplicate that survived a partial failure, a database
// error that could be mistaken for an authorisation answer, a client able to
// certify its own inputs, a context type nothing could safely resolve, a
// status field nothing guarded, and money rules that only applied to callers
// who happened to come in over HTTP.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const Employee = require("../../models/Employee");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DeptUser = require("../../models/Access/DeptUser");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const SpIdempotencyRecord = require("../../models/CMS_Models/StorePurchase/SpIdempotencyRecord");
const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
const { seedSourceBacked, configureProduction } = require("./helpers/sourceBacked");
const Costing = require("../../models/CMS_Models/Costing/Costing");
const CostingVersion = require("../../models/CMS_Models/Costing/CostingVersion");

const idempotencyService = require("../../services/storePurchase/idempotency.service");
const companyContext = require("../../services/centralCosting/companyContext.service");
const { parseCreateRequest } = require("../../services/centralCosting/costingInput");
const creation = require("../../services/centralCosting/costingCreation.service");

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

const newKey = () => `h-${++seq}-${Math.random().toString(36).slice(2)}`;

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
      status: r.status,
      replayed: r.headers.get("Idempotency-Replayed"),
      recovered: r.headers.get("Idempotency-Recovered"),
      body: parsed,
    };
  });

const company = (name) =>
  Acc_Company.create({ companyName: `${name} ${++seq}`, booksFromDate: new Date("2026-04-01") });

async function admin({ companies = [] } = {}) {
  const n = ++seq;
  const email = `harden${n}@test.example`;
  const emp = await Employee.create({
    firstName: "Admin", lastName: `L${n}`, email, biometricId: `HRD${n}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  await DeptUser.create({
    name: "Admin", email, passwordHash: "x", isAdmin: true, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  for (const co of companies) {
    await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "Admin" });
  }
  return {
    emp, email,
    token: jwt.sign(
      { id: String(emp._id), email, name: "Admin", role: "employee", employeeId: emp.biometricId },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
    ),
  };
}

/* ── THE COSTING THESE TESTS CREATE ──────────────────────────────────────
 * `{ context: { type: "ADHOC" } }` was the whole body: no enquiry, no
 * technical record, no policy, and an approvable cost at the end of it. It is
 * closed, so the body is now a real enquiry product's context and the fixture
 * seeds what stands behind it.
 *
 * Every assertion in this suite is about the CREATION — its claim, its
 * idempotency key, its tenancy, its provenance flags — so what the context
 * points at only has to be real, not interesting. */
const sourceBacked = async (co) => {
  const seeded = await seedSourceBacked(co._id);
  await configureProduction(co._id);
  return { context: seeded.context };
};

/* A single seeded context, reused where a test sends the SAME body twice and
   is asserting that the second send is a replay rather than a new costing. */
const create = async (actor, co, body = null, key = newKey()) =>
  call("/", {
    method: "POST", token: actor.token, company: co?._id, idempotencyKey: key,
    body: body || (co ? await sourceBacked(co) : {}),
  });

const enquiry = ({ products = ["Blazer"], title = "Staff uniforms" } = {}) =>
  Enquiry.create({
    enquiryId: `ENQ-${++seq}`,
    journeyId: new mongoose.Types.ObjectId(),
    accountId: new mongoose.Types.ObjectId(),
    title,
    products: products.map((product) => ({ product })),
    isActive: true,
  });

/* ═══ 1 · ONE USER ACTION NEVER PRODUCES TWO COSTINGS ═════════════════════ */

describe("duplicate creation after a partial failure", () => {
  test("a marker that fails after the write does not let a retry create a second costing", async () => {
    const co = await company("Claim");
    const me = await admin({ companies: [co] });
    const key = newKey();

    /* The exact interruption the first pass could not survive: the costing and
       its version commit, and the bookkeeping write that was supposed to
       protect them fails. */
    jest.spyOn(idempotencyService, "markEffectApplied")
      .mockRejectedValueOnce(new Error("simulated marker failure"));

    const body = await sourceBacked(co);
    const first = await create(me, co, body, key);
    expect(first.status).toBeGreaterThanOrEqual(500);

    /* The write DID land — that is the whole premise. */
    expect(await Costing.countDocuments({})).toBe(1);
    expect(await CostingVersion.countDocuments({})).toBe(1);
    const stored = await Costing.findOne({}).lean();
    expect(stored.creationClaimId).toEqual(expect.any(String));
    expect(stored.creationClaimId).toHaveLength(64);

    /* And the retry finds it instead of writing another. */
    const retry = await create(me, co, body, key);
    expect(retry.status).toBe(200);
    expect(retry.recovered).toBe("true");
    expect(retry.body.recovered).toBe(true);
    expect(retry.body.costing.id).toBe(String(stored._id));
    expect(retry.body.versions).toHaveLength(1);
    expect(retry.body.versions[0].versionNumber).toBe(1);

    expect(await Costing.countDocuments({})).toBe(1);
    expect(await CostingVersion.countDocuments({})).toBe(1);

    /* A third attempt is a plain replay: the recovery settled the record. */
    const third = await create(me, co, body, key);
    expect(third.status).toBe(200);
    expect(third.replayed).toBe("true");
    expect(await Costing.countDocuments({})).toBe(1);
  });

  test("the claim outlives the idempotency record, so a reused key is still a conflict", async () => {
    const co = await company("Outlive");
    const me = await admin({ companies: [co] });
    const key = newKey();

    const body = await sourceBacked(co);
    const first = await create(me, co, body, key);
    expect(first.status).toBe(201);

    /* The idempotency record is retained for thirty days; the costing is
       retained forever. Simulate the record having aged out. */
    await SpIdempotencyRecord.deleteMany({});

    /* Same key, same payload → still recovered, not duplicated. */
    const same = await create(me, co, body, key);
    expect(same.status).toBe(200);
    expect(same.body.costing.id).toBe(first.body.costing.id);

    await SpIdempotencyRecord.deleteMany({});

    /* Same key, DIFFERENT payload → still a conflict, from the fingerprint
       stored on the costing itself. */
    const different = await create(me, co, await sourceBacked(co), key);
    expect(different.status).toBe(409);
    expect(different.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");

    expect(await Costing.countDocuments({})).toBe(1);
    expect(await CostingVersion.countDocuments({})).toBe(1);
  });

  test("a lost race on the claim still cleans up version 1 in standalone mode", async () => {
    const co = await company("Race");
    const ctx = companyContext.forService({ companyId: co._id, reason: "test" });
    const input = parseCreateRequest(await sourceBacked(co));
    const claim = { claimId: "a".repeat(64), requestHash: "hash-1" };

    const made = await creation.createCostingWithFirstVersion(ctx, input, { claim });
    expect(made.mode).toBe("COMPENSATED"); // the in-memory harness has no transactions

    /* The second attempt loses the unique index — which happens AFTER its own
       version 1 was written, because the parent is inserted second. */
    await expect(creation.createCostingWithFirstVersion(ctx, input, { claim }))
      .rejects.toMatchObject({ name: "CostingClaimAlreadyUsed" });

    expect(await Costing.countDocuments({})).toBe(1);
    /* The orphan was compensated away rather than left behind. */
    expect(await CostingVersion.countDocuments({})).toBe(1);
  });
});

/* ═══ 2 · A BROKEN LOOKUP IS NOT AN ANSWER ═══════════════════════════════ */

describe("company resolution when the database is unavailable", () => {
  const expectUnavailable = (r) => {
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe("COMPANY_CONTEXT_UNAVAILABLE");
    /* Emphatically NOT the fail-closed authorisation answers, which would send
       the user to an administrator to fix an access problem they do not have. */
    expect(r.body.error.code).not.toBe("TENANT_MEMBERSHIP_UNPROVEN");
    expect(r.body.error.code).not.toBe("FORBIDDEN");
  };

  test("a membership lookup failure is an outage, not a missing membership", async () => {
    const co = await company("Down1");
    const me = await admin({ companies: [co] });

    jest.spyOn(SpCompanyMembership, "find").mockImplementation(() => { throw new Error("db down"); });

    expectUnavailable(await call("/", { token: me.token, company: co._id }));
    expectUnavailable(await create(me, co));
    expect(await Costing.countDocuments({})).toBe(0);
  });

  test("a membership-existence failure cannot switch the single-company fallback on", async () => {
    /* The dangerous shape: exactly one company, no membership rows, so the
       deployment fallback WOULD normally apply. If a failed existence check
       counted as "nobody has a membership", breaking the database would be a
       way to manufacture the fallback's premise. */
    const co = await company("Down2");
    const me = await admin({ companies: [] });

    const ok = await create(me, co);
    expect(ok.status).toBe(201);
    expect(ok.body.visibility.membershipSource).toBe("SINGLE_COMPANY_DEPLOYMENT");
    /* Through the driver, not the models: a persisted version cannot be
       deleted through mongoose at all (see the immutability block below), and
       this is test housekeeping rather than domain behaviour. */
    await mongoose.connection.collection("costings").deleteMany({});
    await mongoose.connection.collection("costing_versions").deleteMany({});

    jest.spyOn(SpCompanyMembership, "exists").mockImplementation(() => { throw new Error("db down"); });

    expectUnavailable(await create(me, co));
    expect(await Costing.countDocuments({})).toBe(0);
  });

  test("a company lookup failure does not become 'no company is set up'", async () => {
    await company("Down3");
    const me = await admin({ companies: [] });

    jest.spyOn(Acc_Company, "find").mockImplementation(() => { throw new Error("db down"); });

    const r = await call("/", { token: me.token });
    expectUnavailable(r);
    expect(r.body.message).not.toMatch(/not linked|no company is set up/i);
  });

  test("an asynchronous failure is caught as well as a synchronous one", async () => {
    const co = await company("Down4");
    const me = await admin({ companies: [co] });

    jest.spyOn(SpCompanyMembership, "find").mockReturnValue({
      select: () => ({ sort: () => ({ lean: () => Promise.reject(new Error("connection reset")) }) }),
    });

    expectUnavailable(await call("/", { token: me.token, company: co._id }));
  });
});

/* ═══ 3 · A CLIENT MAY NOT CERTIFY ITS OWN INPUT ═════════════════════════ */

describe("verified provenance", () => {
  /* The context is incidental here — every assertion is about the confidence
     flag on a source reference. Route tests pass a real enquiry context; the
     one test that parses without a route leaves the default alone. */
  const withSource = (confidence, context = { type: "ADHOC" }) => ({
    context,
    sourceReferences: [{
      sourceType: "SUPPLIER_OFFER", sourceKey: "acme-cotton",
      ...(confidence ? { confidence } : {}),
      snapshot: [{ key: "unitPrice", money: { amountMinor: 41250, currency: "INR" } }],
    }],
  });

  test("a request asking for VERIFIED is refused, not quietly downgraded", async () => {
    const co = await company("Certify");
    const me = await admin({ companies: [co] });

    const ctx = (await sourceBacked(co)).context;
    const r = await create(me, co, withSource("VERIFIED", ctx));
    expect(r.status).toBe(400);
    expect(r.body.error.details.reason).toBe("CONFIDENCE_NOT_CLIENT_SETTABLE");
    expect(r.body.error.details.applied).toBe("PROVISIONAL");
    expect(await Costing.countDocuments({})).toBe(0);
  });

  test("an API source is provisional whether or not it says so", async () => {
    const co = await company("Prov");
    const me = await admin({ companies: [co] });

    /* A separate enquiry product each time: two costings for the same one is
       a conflict, and this test needs two successful creations. */
    for (const confidence of [undefined, "PROVISIONAL"]) {
      const r = await create(me, co, withSource(confidence, (await sourceBacked(co)).context));
      expect(r.status).toBe(201);
      expect(r.body.versions[0].cost.sourceReferences[0].confidence).toBe("PROVISIONAL");
    }
  });

  test("only an internal service context can record a verified source", async () => {
    const co = await company("Trusted");

    /* The trusted path: parsed with `trusted`, written under a service
       context that no request can construct. */
    const input = parseCreateRequest(withSource("VERIFIED"), { trusted: true });
    expect(input.sourceReferences[0].confidence).toBe("VERIFIED");

    const service = companyContext.forService({ companyId: co._id, reason: "legacy import test" });
    const made = await creation.createCostingWithFirstVersion(service, input, {});
    expect(made.version.sourceReferences[0].confidence).toBe("VERIFIED");

    /* And the second lock: the same trusted-parsed input, written under an
       ordinary employee context, is refused on the far side of the parser. */
    const employeeCtx = { ...service, actorType: "employee" };
    await expect(creation.createCostingWithFirstVersion(employeeCtx, input, {}))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  test("no request value can reach the trusted flag", async () => {
    const co = await company("NoTrust");
    const me = await admin({ companies: [co] });

    const ctx = (await sourceBacked(co)).context;
    for (const smuggle of [{ trusted: true }, { trusted: "true" }, { options: { trusted: true } }]) {
      const r = await create(me, co, { ...withSource("VERIFIED", ctx), ...smuggle });
      expect(r.status).toBe(400);
      expect(r.body.error.details.reason).toBe("CONFIDENCE_NOT_CLIENT_SETTABLE");
    }
  });
});

/* ═══ 4 · ONLY THE CONTEXTS THE SERVER CAN PROVE ═════════════════════════ */

describe("context types", () => {
  test("style, order and sample-style are refused with a stable reason", async () => {
    const co = await company("Narrow");
    const me = await admin({ companies: [co] });

    for (const type of ["STYLE", "ORDER", "SAMPLE_STYLE"]) {
      const r = await create(me, co, {
        context: { type, primaryId: String(new mongoose.Types.ObjectId()) },
      });
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe("CONTEXT_NOT_SUPPORTED_YET");
      expect(r.body.error.details.enabled).toEqual(["ADHOC", "ENQUIRY_STYLE"]);
    }
    expect(await Costing.countDocuments({})).toBe(0);
  });

  test("an enquiry costing is resolved server-side and snapshotted from the enquiry", async () => {
    const co = await company("Enq");
    const me = await admin({ companies: [] }); // single-company deployment
    const enq = await enquiry({ products: ["Blazer", "Trouser"], title: "ITC uniforms" });

    const r = await create(me, co, {
      context: { type: "ENQUIRY_STYLE", primaryId: String(enq._id), externalKey: "Blazer" },
    });
    expect(r.status).toBe(201);

    /* Built from the document, not from the request. */
    expect(r.body.costing.contextSnapshot.label).toBe(`Blazer — ${enq.enquiryId}`);
    const facts = Object.fromEntries(
      r.body.costing.contextSnapshot.facts.map((f) => [f.key, f.value]),
    );
    expect(facts.enquiryId).toBe(enq.enquiryId);
    expect(facts.enquiryTitle).toBe("ITC uniforms");
    expect(facts.product).toBe("Blazer");
    /* How ownership was established, frozen into the record. */
    expect(facts.scopeProof).toBe("SINGLE_COMPANY_DEPLOYMENT");
  });

  test("a client cannot caption somebody else's document", async () => {
    const co = await company("Caption");
    const me = await admin({ companies: [] });
    const enq = await enquiry();

    const r = await create(me, co, {
      context: { type: "ENQUIRY_STYLE", primaryId: String(enq._id), externalKey: "Blazer" },
      label: "Whatever I like",
    });
    expect(r.status).toBe(400);
    expect(r.body.error.details.reason).toBe("CONTEXT_SNAPSHOT_SERVER_GENERATED");
  });

  test("a product the enquiry does not list is refused", async () => {
    const co = await company("Product");
    const me = await admin({ companies: [] });
    const enq = await enquiry({ products: ["Blazer"] });

    const r = await create(me, co, {
      context: { type: "ENQUIRY_STYLE", primaryId: String(enq._id), externalKey: "Kurta" },
    });
    expect(r.status).toBe(400);
    expect(r.body.error.details.reason).toBe("CONTEXT_PRODUCT_NOT_IN_ENQUIRY");
    expect(r.body.error.details.available).toEqual(["Blazer"]);
  });

  test("in a multi-company deployment, an existing enquiry id is indistinguishable from a made-up one", async () => {
    /* ── THE ORACLE THIS PINS SHUT ──────────────────────────────────────
       The refusal used to be decided AFTER the enquiry was fetched, so it
       varied with what the fetch found: a real id got CONTEXT_NOT_SUPPORTED_YET
       and an invented one got NOT_FOUND. That let anyone with this endpoint
       enumerate other companies' enquiry ids one guess at a time. The scoping
       question is now settled before any enquiry is read. */
    const a = await company("OracleA");
    await company("OracleB");
    const me = await admin({ companies: [a] });
    const real = await enquiry({ products: ["Blazer"] });

    const ctx = { type: "ENQUIRY_STYLE", externalKey: "Blazer" };
    const exists = await create(me, a, { context: { ...ctx, primaryId: String(real._id) } });
    const invented = await create(me, a, {
      context: { ...ctx, primaryId: String(new mongoose.Types.ObjectId()) },
    });

    expect(exists.status).toBe(invented.status);
    expect(exists.body).toEqual(invented.body);
    /* Chunk 3A gave Enquiry a `companyId`, so an UNOWNED enquiry in a
       multi-company deployment now fails closed as NOT FOUND rather than with
       a distinct "not company-scoped" code. That is strictly stronger: the
       refusal no longer says anything about why, and matches the answer a
       genuinely missing enquiry gets. */
    expect(exists.status).toBe(404);
    expect(exists.body.error.code).toBe("NOT_FOUND");
    expect(await Costing.countDocuments({})).toBe(0);
  });

  test("an inactive enquiry is answered like a missing one, never as 'it exists but'", async () => {
    const co = await company("Inactive");
    const me = await admin({ companies: [] }); // single-company deployment
    const enq = await enquiry();
    await Enquiry.updateOne({ _id: enq._id }, { $set: { isActive: false } });

    const ctx = { type: "ENQUIRY_STYLE", externalKey: "Blazer" };
    const inactive = await create(me, co, { context: { ...ctx, primaryId: String(enq._id) } });
    const missing = await create(me, co, {
      context: { ...ctx, primaryId: String(new mongoose.Types.ObjectId()) },
    });

    expect(inactive.status).toBe(404);
    expect(inactive.body).toEqual(missing.body);
  });

  test("with Sales records carrying a company, one scoped query answers foreign and missing alike", async () => {
    /* ── NO LONGER A SIMULATION ────────────────────────────────────────
       This test used to add `companyId` to the Enquiry schema at runtime and
       remove it again, because the field did not exist. Chunk 3A made it real,
       and the removal in that `finally` then stripped the genuine field for
       every test that ran afterwards — a fixture quietly disabling the thing
       under test. It sets the field directly now. */
    const a = await company("ScopedA");
    const b = await company("ScopedB");
    const me = await admin({ companies: [a] });

    const mine = await enquiry({ products: ["Blazer"] });
    await Enquiry.updateOne({ _id: mine._id }, { $set: { companyId: a._id } });

    const theirs = await enquiry({ products: ["Blazer"] });
    await Enquiry.updateOne({ _id: theirs._id }, { $set: { companyId: b._id } });

    const ctx = { type: "ENQUIRY_STYLE", externalKey: "Blazer" };

    /* Ours resolves — and note there are two companies, so the deployment
       fallback is NOT what let it through; the scoped query did. */
    const ok = await create(me, a, { context: { ...ctx, primaryId: String(mine._id) } });
    expect(ok.status).toBe(201);
    const facts = Object.fromEntries(
      ok.body.costing.contextSnapshot.facts.map((f) => [f.key, f.value]),
    );
    expect(facts.scopeProof).toBe("DOCUMENT_COMPANY");

    /* Theirs, and one that never existed, are the same answer. */
    const foreign = await create(me, a, { context: { ...ctx, primaryId: String(theirs._id) } });
    const missing = await create(me, a, {
      context: { ...ctx, primaryId: String(new mongoose.Types.ObjectId()) },
    });
    expect(foreign.status).toBe(404);
    expect(foreign.body).toEqual(missing.body);
  });

  test("an unowned enquiry is refused where ownership cannot be proved, and never sets the company", async () => {
    const a = await company("MultiA");
    await company("MultiB");
    const me = await admin({ companies: [a] });
    const enq = await enquiry();

    const r = await create(me, a, {
      context: { type: "ENQUIRY_STYLE", primaryId: String(enq._id), externalKey: "Blazer" },
    });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe("NOT_FOUND");

    /* And the actor's own company is still their membership's — the enquiry
       never contributed to it. */
    const who = await call("/", { token: me.token, company: a._id });
    expect(who.body.visibility.companyId).toBe(String(a._id));
  });
});

/* ═══ 5 · A PERSISTED VERSION IS FROZEN, INCLUDING ITS STATUS ════════════ */

describe("immutability", () => {
  const aVersion = async () => {
    const co = await company("Frozen");
    const v = await CostingVersion.create({
      companyId: co._id, costingId: new mongoose.Types.ObjectId(),
      versionNumber: 1, baseCurrency: "INR",
      provenance: { origin: "MANUAL", createdAt: new Date() },
    });
    return v;
  };

  test("status cannot be moved by any mongoose write path", async () => {
    const v = await aVersion();

    v.status = "APPROVED";
    await expect(v.save()).rejects.toThrow(/immutable/i);

    await expect(CostingVersion.updateOne({ _id: v._id }, { $set: { status: "APPROVED" } }))
      .rejects.toThrow(/immutable/i);
    await expect(CostingVersion.updateMany({}, { $set: { status: "APPROVED" } }))
      .rejects.toThrow(/immutable/i);
    await expect(CostingVersion.findOneAndUpdate({ _id: v._id }, { $set: { status: "SUPERSEDED" } }))
      .rejects.toThrow(/immutable/i);

    const fresh = await CostingVersion.findById(v._id).lean();
    expect(fresh.status).toBe("DRAFT");
  });

  test("a whole-document replacement is refused too", async () => {
    const v = await aVersion();
    const replacement = {
      companyId: v.companyId, costingId: v.costingId, versionNumber: 1,
      status: "APPROVED", baseCurrency: "USD",
      provenance: { origin: "MANUAL", createdAt: new Date() },
    };

    await expect(CostingVersion.replaceOne({ _id: v._id }, replacement))
      .rejects.toMatchObject({ name: "CostingVersionImmutableError" });
    await expect(CostingVersion.findOneAndReplace({ _id: v._id }, replacement))
      .rejects.toMatchObject({ name: "CostingVersionImmutableError" });

    const fresh = await CostingVersion.findById(v._id).lean();
    expect(fresh.status).toBe("DRAFT");
    expect(fresh.baseCurrency).toBe("INR");
  });

  test("an UPSERTING replacement is refused as well — the check-then-write race is gone", async () => {
    /* This used to be allowed on the reasoning that an upsert which inserts is
       a creation rather than a rewrite. Two things were wrong with it: the
       existence check and the write were separate, so a document inserted in
       between was replaced rather than created; and a version created this way
       would have had no number allocated, no provenance stamped and no parent
       pointer maintained. Both replacement APIs are now refused
       unconditionally — no query, so no race. */
    const co = await company("Upsert");
    const doc = {
      companyId: co._id, costingId: new mongoose.Types.ObjectId(), versionNumber: 1,
      baseCurrency: "INR", provenance: { origin: "MANUAL", createdAt: new Date() },
    };

    await expect(CostingVersion.replaceOne(
      { _id: new mongoose.Types.ObjectId() }, doc, { upsert: true },
    )).rejects.toMatchObject({ name: "CostingVersionImmutableError" });

    await expect(CostingVersion.findOneAndReplace(
      { _id: new mongoose.Types.ObjectId() }, doc, { upsert: true },
    )).rejects.toMatchObject({ name: "CostingVersionImmutableError" });

    /* Nothing was created by the refusal. */
    expect(await CostingVersion.countDocuments({})).toBe(0);
  });

  test("a persisted version cannot be deleted by any ordinary path", async () => {
    const v = await aVersion();

    await expect(CostingVersion.deleteOne({ _id: v._id })).rejects.toThrow(/audit history/i);
    await expect(CostingVersion.deleteMany({})).rejects.toThrow(/audit history/i);
    await expect(CostingVersion.findOneAndDelete({ _id: v._id })).rejects.toThrow(/audit history/i);
    await expect(CostingVersion.findByIdAndDelete(v._id)).rejects.toThrow(/audit history/i);
    /* Document-level deletion is separate middleware from the query-level call
       of the same name, so it is registered separately and checked here. */
    await expect(v.deleteOne()).rejects.toThrow(/audit history/i);

    expect(await CostingVersion.countDocuments({ _id: v._id })).toBe(1);
  });

  test("the orphan cleanup removes a parentless version and refuses a real one", async () => {
    const co = await company("Orphan");

    /* An orphan: a version whose parent costing was never created — exactly
       what a failed parent insert leaves behind in compensated mode. */
    const orphan = await CostingVersion.create({
      companyId: co._id, costingId: new mongoose.Types.ObjectId(),
      versionNumber: 1, baseCurrency: "INR",
      provenance: { origin: "MANUAL", createdAt: new Date() },
    });
    await expect(CostingVersion.deleteOrphanVersion({ _id: orphan._id, companyId: co._id }))
      .resolves.toEqual({ deleted: 1, reason: "ORPHAN_REMOVED" });
    expect(await CostingVersion.countDocuments({ _id: orphan._id })).toBe(0);

    /* A version whose parent EXISTS is history, and the same function refuses
       it — the narrowing is a fact it verifies, not a flag a caller passes. */
    const me = await admin({ companies: [co] });
    const made = await create(me, co);
    const real = await CostingVersion.findOne({ costingId: made.body.costing.id });
    await expect(CostingVersion.deleteOrphanVersion({ _id: real._id, companyId: co._id }))
      .rejects.toMatchObject({ name: "CostingVersionCleanupError" });
    expect(await CostingVersion.countDocuments({ _id: real._id })).toBe(1);

    /* Another company cannot reach it either: the version is looked up under
       the company it was asked for, so a wrong company is simply absent. */
    const other = await company("OrphanOther");
    await expect(CostingVersion.deleteOrphanVersion({ _id: real._id, companyId: other._id }))
      .resolves.toEqual({ deleted: 0, reason: "ALREADY_ABSENT" });
    expect(await CostingVersion.countDocuments({ _id: real._id })).toBe(1);
  });

  test("a failed parent insert still leaves no version behind", async () => {
    const co = await company("Cleanup");
    const me = await admin({ companies: [co] });

    jest.spyOn(Costing, "create").mockRejectedValueOnce(new Error("simulated write failure"));

    const r = await create(me, co);
    expect(r.status).toBeGreaterThanOrEqual(400);

    /* The compensating delete goes through `deleteOrphanVersion`, so the
       deletion guard above does not block the one removal that must happen. */
    expect(await Costing.countDocuments({})).toBe(0);
    expect(await CostingVersion.countDocuments({})).toBe(0);
  });
});

/* ═══ 6 · MONEY RULES HOLD FOR EVERY WRITER, NOT ONLY HTTP ═══════════════ */

describe("model-level money validation", () => {
  const withFacts = async (snapshot) => {
    const co = await company("Money");
    return CostingVersion.create({
      companyId: co._id, costingId: new mongoose.Types.ObjectId(),
      versionNumber: 1, baseCurrency: "INR",
      provenance: { origin: "LEGACY_IMPORT", createdAt: new Date() },
      sourceReferences: [{ sourceType: "MANUAL_ENTRY", sourceKey: "x", snapshot }],
    });
  };

  test("a fractional amount is refused even by an internal writer", async () => {
    await expect(withFacts([{ key: "p", money: { amountMinor: 412.5, currency: "INR" } }]))
      .rejects.toThrow(/whole/i);
  });

  test("an amount too large to add exactly is refused", async () => {
    await expect(withFacts([{ key: "p", money: { amountMinor: Number.MAX_SAFE_INTEGER + 2, currency: "INR" } }]))
      .rejects.toThrow(/exactly-representable|whole/i);
  });

  test("a currency outside the allowlist is refused", async () => {
    await expect(withFacts([{ key: "p", money: { amountMinor: 100, currency: "XXX" } }]))
      .rejects.toThrow();
  });

  test("a non-finite numeric fact is refused", async () => {
    await expect(withFacts([{ key: "sam", num: Infinity }])).rejects.toThrow(/finite/i);
    await expect(withFacts([{ key: "sam", num: NaN }])).rejects.toThrow();
  });

  test("a fact carries exactly one value — never two, never none", async () => {
    await expect(withFacts([{ key: "p", num: 1, text: "one" }]))
      .rejects.toThrow(/exactly one value/i);
    await expect(withFacts([{ key: "p", num: 1, money: { amountMinor: 1, currency: "INR" } }]))
      .rejects.toThrow(/exactly one value/i);
    await expect(withFacts([{ key: "p" }])).rejects.toThrow(/no value/i);
  });

  test("zero is valid, and stays distinct from missing", async () => {
    const v = await withFacts([
      { key: "waived", money: { amountMinor: 0, currency: "INR" } },
      { key: "count", num: 0 },
    ]);
    const facts = v.sourceReferences[0].snapshot;
    expect(facts[0].money.amountMinor).toBe(0);
    expect(facts[0].text).toBeUndefined();
    expect(facts[1].num).toBe(0);
    expect(facts[1].money).toBeUndefined();
  });
});
