// test/costing/costing-claim-and-credits.test.js
//
// Central Costing — Chunk 2, second correction pass.
//
// Four defects the first correction pass left behind, each pinned with the
// behaviour it replaces:
//
//   · the legacy import bound its TEMPORARY idempotency row to the costing but
//     wrote no DURABLE claim onto the version, so the protection expired;
//   · `provenance.creationClaimTarget` was declared and never written;
//   · credits could drive a scenario's net cost below zero and out the other
//     side as negative "selling prices";
//   · the policy screen still described the behaviour that was removed.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const fs = require("fs");
const path = require("path");
const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const Employee = require("../../models/Employee");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DeptUser = require("../../models/Access/DeptUser");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const SpIdempotencyRecord = require("../../models/CMS_Models/StorePurchase/SpIdempotencyRecord");
const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
const { seedSourceBacked, configureProduction, prepareForCosting } = require("./helpers/sourceBacked");
const Costing = require("../../models/CMS_Models/Costing/Costing");
const CostingVersion = require("../../models/CMS_Models/Costing/CostingVersion");
const CostingClaim = require("../../models/CMS_Models/Costing/CostingClaim");
const { calculate, CostingEngineError } = require("../../services/centralCosting/engine");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/costings", require("../../routes/CMS_Routes/Costing/costings"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/costings`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const newKey = () => `cc-${++seq}-${Math.random().toString(36).slice(2)}`;

const call = (path_, { method = "GET", body, token, idempotencyKey, company } = {}) =>
  fetch(`${base}${path_}`, {
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

async function admin(companies = []) {
  const n = ++seq;
  const email = `cc-${n}@test.example`;
  const emp = await Employee.create({
    firstName: "A", lastName: `L${n}`, email, biometricId: `CC${n}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  await DeptUser.create({
    name: "A", email, passwordHash: "x", isAdmin: true, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  for (const co of companies) {
    await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "A" });
  }
  return {
    token: jwt.sign(
      { id: String(emp._id), email, name: "A", role: "employee", employeeId: emp.biometricId },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
    ),
  };
}

const POLICY = {
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
  revision: 0,
};

const SCENARIOS = [{ key: "q500", label: "500 pcs", quantity: "500", isPrimary: true }];

/* ── NO LINES ────────────────────────────────────────────────────────────
 * This suite is about idempotency keys, creation claims and receipts, not
 * about arithmetic. The costing it works on is source-backed, so the server
 * assembles the rows from the technical record, the supplier quotation and
 * the company policy, and every calculation here is deterministic without a
 * single figure being typed by the test. */
const LINES = [];

/**
 * The company rules a legacy import needs.
 *
 * ── AND THE BOARD'S MARGIN BAND WITH THEM ───────────────────────────────────
 * The costing policy no longer carries what the company sells for. Without an
 * approved band there is no price to solve for, so a version cannot be frozen
 * at all — which would make every assertion below about idempotency and claims
 * fail for a reason that has nothing to do with them.
 */
const savePolicy = async (me, co) => {
  const r = await call("/policy/current", {
    method: "PUT", token: me.token, company: co._id, body: POLICY,
  });
  await configureProduction(co._id);
  return r;
};

/**
 * A costing to hold keys and claims against.
 *
 * ── IT USED TO BE AD-HOC ──────────────────────────────────────────────────
 * Two lines and no fixtures, and a version could be built from whatever the
 * test posted — the same shortcut a user had. The fixture seeds the enquiry
 * product, technical record, quotation and policy a real costing needs; every
 * claim, receipt and tenancy assertion below is unchanged.
 */
async function adhocCosting(me, co, product = null) {
  const seeded = await seedSourceBacked(co._id, product ? { product } : {});
  await configureProduction(co._id);
  const r = await call("/", {
    method: "POST", token: me.token, company: co._id, idempotencyKey: newKey(),
    body: { context: seeded.context },
  });
  expect(r.status).toBe(201);
  return r.body.costing.id;
}

/** An enquiry costing with one readable legacy sheet row. */
async function enquiryCosting(me, co, product = "Blazer") {
  const enq = await Enquiry.create({
    enquiryId: `ENQ-${++seq}`,
    journeyId: new mongoose.Types.ObjectId(),
    accountId: new mongoose.Types.ObjectId(),
    title: "Uniforms", products: [{ product }], isActive: true,
    costingSheets: [{ productName: product, part: "raw",
      materials: [{ item: "Cotton", unitCost: "412.50", consumption: "1.4", unit: "m" }] }],
  });
  const made = await call("/", {
    method: "POST", token: me.token, company: co._id, idempotencyKey: newKey(),
    body: { context: { type: "ENQUIRY_STYLE", primaryId: String(enq._id), externalKey: product } },
  });
  expect(made.status).toBe(201);
  return made.body.costing.id;
}

/* ── THE LEGACY IMPORT STILL CARRIES ITS OWN QUANTITIES ────────────────────
 * `POST /versions` reads the Sales costing brief now and refuses a payload
 * carrying scenarios. This route does NOT: it builds a version from a
 * historical Sales costing sheet, which predates briefs entirely and states
 * its own run sizes. Demanding a confirmed brief would make every historical
 * enquiry permanently un-importable. */
const importLegacy = (me, co, id, key, extra = {}) =>
  call(`/${id}/versions/legacy-import`, {
    method: "POST", token: me.token, company: co._id, idempotencyKey: key,
    body: { scenarios: SCENARIOS, ...extra },
  });

const calculateVersion = (me, co, id, key = newKey(), body = { lines: LINES }) =>
  call(`/${id}/versions`, { method: "POST", token: me.token, company: co._id, idempotencyKey: key, body });

/* ═══ 1 · THE LEGACY IMPORT'S CLAIM IS DURABLE ═══════════════════════════ */

describe("legacy import idempotency survives the bookkeeping row", () => {
  test("a normal import stores its creation claim and target", async () => {
    const co = await company("LegacyClaim");
    const me = await admin([]); // single-company deployment
    await savePolicy(me, co);
    const id = await enquiryCosting(me, co);

    const r = await importLegacy(me, co, id, newKey());
    expect(r.status).toBe(201);

    /* WAS: nothing was written here at all — the version carried no claim, so
       the protection lasted exactly as long as the SpIdempotencyRecord did. */
    const version = await CostingVersion.findOne({ costingId: id, versionNumber: 2 }).lean();
    expect(version.provenance.creationClaimId).toEqual(expect.any(String));
    expect(version.provenance.creationClaimId).toHaveLength(64);
    expect(version.provenance.creationClaimTarget).toBe(`costing:${id}`);
    expect(version.provenance.creationRequestHash).toEqual(expect.any(String));
    /* The content key still does its own, different job. */
    expect(version.provenance.legacyImportKey).toEqual(expect.any(String));
  });

  test("after the row is deleted, the same key on the same costing recovers", async () => {
    const co = await company("LegacyRecover");
    const me = await admin([]);
    await savePolicy(me, co);
    const id = await enquiryCosting(me, co);
    const key = newKey();

    const first = await importLegacy(me, co, id, key);
    expect(first.status).toBe(201);

    await SpIdempotencyRecord.deleteMany({});

    const again = await importLegacy(me, co, id, key);
    expect(again.status).toBe(200);
    expect(again.body.recovered).toBe(true);
    expect(again.body.versions[0].id).toBe(first.body.versions[0].id);
    /* No extra version, either way. */
    expect(await CostingVersion.countDocuments({ costingId: id })).toBe(2);
  });

  test("after the row is deleted, the same key on ANOTHER costing is refused", async () => {
    const co = await company("LegacyCross");
    const me = await admin([]);
    await savePolicy(me, co);
    const a = await enquiryCosting(me, co, "Blazer");
    const b = await enquiryCosting(me, co, "Trouser");
    const key = newKey();

    await importLegacy(me, co, a, key);
    await SpIdempotencyRecord.deleteMany({});

    /* WAS: with no durable claim, this imported cleanly into B under a key
       that had already been spent on A. */
    const cross = await importLegacy(me, co, b, key);
    expect(cross.status).toBe(409);
    expect(cross.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(cross.body.error.details.reason).toBe("DIFFERENT_COSTING");
    expect(cross.body.error.details.operation).toBe("COSTING_LEGACY_IMPORT");

    expect(await CostingVersion.countDocuments({ costingId: b })).toBe(1); // draft only
    expect(await CostingVersion.countDocuments({ costingId: a })).toBe(2);
  });

  test("content deduplication still works independently of the claim", async () => {
    const co = await company("LegacyContent");
    const me = await admin([]);
    await savePolicy(me, co);
    const id = await enquiryCosting(me, co);

    const first = await importLegacy(me, co, id, newKey());
    /* A DIFFERENT key, same unchanged sheet: the content key catches it. */
    const second = await importLegacy(me, co, id, newKey());
    expect(second.status).toBe(200);
    expect(second.body.recovered).toBe(true);
    expect(second.body.versions[0].id).toBe(first.body.versions[0].id);
    expect(await CostingVersion.countDocuments({ costingId: id })).toBe(2);
  });
});

/* ═══ 1b · A KEY THAT RESOLVED TO SOMEBODY ELSE'S VERSION ════════════════ */

describe("an aliasing key is bound just as permanently as a creating one", () => {
  /* ── THE HOLE THIS BLOCK PINS SHUT ─────────────────────────────────────
     A second key importing an UNCHANGED sheet is answered from the content
     hash. It never touches the version's `provenance` — it cannot, the version
     is frozen and belongs to the first key — so its only trace used to be the
     temporary idempotency row. Once that expired, the key had no history and
     could be spent again on a different costing. */

  test("the aliasing key gets its own durable receipt, and no second version", async () => {
    const co = await company("AliasReceipt");
    const me = await admin([]);
    await savePolicy(me, co);
    const id = await enquiryCosting(me, co);

    const k1 = newKey();
    const k2 = newKey();
    const first = await importLegacy(me, co, id, k1);
    const second = await importLegacy(me, co, id, k2);

    expect(second.status).toBe(200);
    expect(second.body.versions[0].id).toBe(first.body.versions[0].id);
    expect(await CostingVersion.countDocuments({ costingId: id })).toBe(2); // draft + import

    /* TWO keys, TWO receipts, ONE version — which is exactly why receipts are
       a separate collection rather than a field on a frozen document. */
    const receipts = await CostingClaim.find({ companyId: co._id }).lean();
    expect(receipts).toHaveLength(2);
    expect(new Set(receipts.map((r) => String(r.versionId))).size).toBe(1);
    expect(String(receipts[0].versionId)).toBe(first.body.versions[0].id);
    expect(receipts.map((r) => r.resolution).sort()).toEqual(["CONTENT_DEDUPLICATED", "CREATED"]);
    for (const r of receipts) {
      expect(r.target).toBe(`costing:${id}`);
      expect(String(r.costingId)).toBe(id);
      expect(r.requestHash).toEqual(expect.any(String));
    }
  });

  test("after the bookkeeping row is deleted, the aliasing key still recovers the same version", async () => {
    const co = await company("AliasRecover");
    const me = await admin([]);
    await savePolicy(me, co);
    const id = await enquiryCosting(me, co);

    const k1 = newKey();
    const k2 = newKey();
    const first = await importLegacy(me, co, id, k1);
    await importLegacy(me, co, id, k2);

    await SpIdempotencyRecord.deleteMany({});

    const again = await importLegacy(me, co, id, k2);
    expect(again.status).toBe(200);
    expect(again.body.recovered).toBe(true);
    expect(again.body.versions[0].id).toBe(first.body.versions[0].id);
    expect(await CostingVersion.countDocuments({ costingId: id })).toBe(2);
  });

  test("after the row is deleted, the aliasing key is refused against another costing", async () => {
    const co = await company("AliasCross");
    const me = await admin([]);
    await savePolicy(me, co);
    const a = await enquiryCosting(me, co, "Blazer");
    const b = await enquiryCosting(me, co, "Trouser");

    const k1 = newKey();
    const k2 = newKey();
    await importLegacy(me, co, a, k1);
    await importLegacy(me, co, a, k2); // k2 aliases k1's version by content

    await SpIdempotencyRecord.deleteMany({});

    /* WAS: k2 had nothing durable behind it, so this imported cleanly into B
       under a key that had already been spent on A. */
    const cross = await importLegacy(me, co, b, k2);
    expect(cross.status).toBe(409);
    expect(cross.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(cross.body.error.details.reason).toBe("DIFFERENT_COSTING");

    expect(await CostingVersion.countDocuments({ costingId: b })).toBe(1); // draft only
  });

  /* ── AND A TEST ABOUT ALIASING ONE KEY ACROSS TWO OPERATIONS ──────────
     It spent a key on `legacy-import`, then spent the same raw key on the
     manual calculation route — two different actions, by design, because
     `operation` has been part of the claim identity since Chunk 1 — and then
     re-aimed THAT claim at a third costing and read `IDEMPOTENCY_KEY_REUSED ·
     DIFFERENT_COSTING`.

     The manual calculation route refuses a browser client now, so there is no
     second operation to alias onto. The two halves of what it proved both
     survive: `operation` is still part of the shared `SpIdempotencyRecord`
     identity, exercised by the routes that still write — `legacy-import`,
     `submit` and `approve` — and the binding of a claim to what it was spent
     on is asserted against the orchestration in
     `sales-estimate-preparation.test.js`. */


  test("a corrected payload under the same key is still refused, receipt or not", async () => {
    /* The request-hash comparison is not weakened by any of this. */
    const co = await company("AliasPayload");
    const me = await admin([]);
    await savePolicy(me, co);
    const id = await enquiryCosting(me, co);
    const key = newKey();

    await importLegacy(me, co, id, key);
    await SpIdempotencyRecord.deleteMany({});

    /* A genuinely different payload under the same key. The legacy import
       still carries its own quantities, so a different run size is what makes
       it different. */
    const different = await importLegacy(me, co, id, key, {
      scenarios: [{ key: "q100", quantity: "100", isPrimary: true }],
    });
    expect(different.status).toBe(409);
    expect(different.body.error.details.reason).toBe("DIFFERENT_PAYLOAD");
    expect(await CostingVersion.countDocuments({ costingId: id })).toBe(2);
  });

  test("two concurrent imports under different keys make one version and two receipts", async () => {
    const co = await company("AliasRace");
    const me = await admin([]);
    await savePolicy(me, co);
    const id = await enquiryCosting(me, co);

    const [a, b] = await Promise.all([
      importLegacy(me, co, id, newKey()),
      importLegacy(me, co, id, newKey()),
    ]);

    expect([a.status, b.status].every((s) => s === 200 || s === 201)).toBe(true);
    expect(a.body.versions[0].id).toBe(b.body.versions[0].id);
    /* One version, whichever of them won the content index. */
    expect(await CostingVersion.countDocuments({ costingId: id })).toBe(2);

    const receipts = await CostingClaim.find({ companyId: co._id }).lean();
    expect(receipts).toHaveLength(2);
    expect(new Set(receipts.map((r) => String(r.versionId))).size).toBe(1);
  });

  /* ═══ MANDATORY PERSISTENCE ══════════════════════════════════════════
     The receipt IS an aliasing key's binding, so a failed write cannot be
     reported as success. Failure is injected at the model — the smallest
     mechanism that reaches the real code path, and one that leaves no
     test-only flag in production behaviour. */

  test("an alias whose receipt cannot be written does not report success", async () => {
    const co = await company("MandatoryFail");
    const me = await admin([]);
    await savePolicy(me, co);
    const id = await enquiryCosting(me, co);

    await importLegacy(me, co, id, newKey()); // the creating key
    const aliasKey = newKey();

    /* Not a duplicate-key error — a genuine write failure. */
    jest.spyOn(CostingClaim, "create").mockRejectedValueOnce(new Error("connection reset"));

    const r = await importLegacy(me, co, id, aliasKey);

    /* WAS: 200, with the key silently unbound once the temporary row expired. */
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe("COSTING_CLAIM_PERSISTENCE_FAILED");
    expect(r.body.error.details.reason).toBe("CLAIM_RECEIPT_WRITE_FAILED");

    /* No second version — the import itself was never repeated. */
    expect(await CostingVersion.countDocuments({ costingId: id })).toBe(2);
    /* No receipt for the alias key. */
    expect(await CostingClaim.countDocuments({ companyId: co._id })).toBe(1);

    /* And the action was NOT completed: a refusal must never become a
       replayable success. */
    const record = await SpIdempotencyRecord.findOne({ key: aliasKey }).lean();
    expect(record.status).not.toBe("COMPLETED");
    expect(record.responseStatus).toBeUndefined();

    jest.restoreAllMocks();
  });

  test("retrying the same key finishes the receipt and returns the same version", async () => {
    const co = await company("MandatoryRetry");
    const me = await admin([]);
    await savePolicy(me, co);
    const id = await enquiryCosting(me, co);

    const first = await importLegacy(me, co, id, newKey());
    const aliasKey = newKey();

    jest.spyOn(CostingClaim, "create").mockRejectedValueOnce(new Error("connection reset"));
    expect((await importLegacy(me, co, id, aliasKey)).status).toBe(503);
    jest.restoreAllMocks();

    /* The retry does not repeat the import: it finds the same version by
       content and finishes the record that failed. */
    const retry = await importLegacy(me, co, id, aliasKey);
    expect(retry.status).toBe(200);
    expect(retry.body.recovered).toBe(true);
    expect(retry.body.versions[0].id).toBe(first.body.versions[0].id);

    expect(await CostingVersion.countDocuments({ costingId: id })).toBe(2);
    const receipts = await CostingClaim.find({ companyId: co._id }).lean();
    expect(receipts).toHaveLength(2);
    expect(new Set(receipts.map((r) => String(r.versionId))).size).toBe(1);
  });

  test("and once persisted, the binding survives the bookkeeping row and refuses another costing", async () => {
    const co = await company("MandatoryDurable");
    const me = await admin([]);
    await savePolicy(me, co);
    const a = await enquiryCosting(me, co, "Blazer");
    const b = await enquiryCosting(me, co, "Trouser");

    await importLegacy(me, co, a, newKey());
    const aliasKey = newKey();

    jest.spyOn(CostingClaim, "create").mockRejectedValueOnce(new Error("connection reset"));
    expect((await importLegacy(me, co, a, aliasKey)).status).toBe(503);
    jest.restoreAllMocks();

    expect((await importLegacy(me, co, a, aliasKey)).status).toBe(200); // receipt persisted
    await SpIdempotencyRecord.deleteMany({});

    /* Same costing, same payload → still recovers. */
    const same = await importLegacy(me, co, a, aliasKey);
    expect(same.status).toBe(200);
    expect(same.body.recovered).toBe(true);

    await SpIdempotencyRecord.deleteMany({});

    /* Another costing → refused, which is the guarantee the failed write would
       otherwise have quietly dropped. */
    const cross = await importLegacy(me, co, b, aliasKey);
    expect(cross.status).toBe(409);
    expect(cross.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(await CostingVersion.countDocuments({ costingId: b })).toBe(1);
  });

  test("a genuinely identical duplicate receipt is an idempotent success", async () => {
    const co = await company("DupIdentical");
    const me = await admin([co]);
    const { recordClaimReceipt } = require("../../services/centralCosting/versionCreation.service");
    const ctx = { companyId: co._id, actorId: "a" };
    const costing = { _id: new mongoose.Types.ObjectId() };
    const version = { _id: new mongoose.Types.ObjectId(), versionNumber: 2 };
    const args = {
      claim: { claimId: "c".repeat(64), target: "costing:x", requestHash: "h1" },
      operation: "COSTING_LEGACY_IMPORT", costing, version, mandatory: true,
    };

    expect(await recordClaimReceipt(ctx, args)).toMatchObject({ recorded: true, reason: "WRITTEN" });
    /* The same write again: redundant, and the binding is already in place. */
    expect(await recordClaimReceipt(ctx, args)).toMatchObject({ recorded: true, reason: "ALREADY_RECORDED" });
    expect(await CostingClaim.countDocuments({ companyId: co._id })).toBe(1);
    expect(me).toBeTruthy();
  });

  test("a duplicate that disagrees about anything is refused, not accepted", async () => {
    /* `11000` means only "that claim id is taken" — it says nothing about what
       it was taken FOR. Accepting every duplicate would call a key bound when
       it is bound to something else. */
    const co = await company("DupConflict");
    const { recordClaimReceipt } = require("../../services/centralCosting/versionCreation.service");
    const ctx = { companyId: co._id, actorId: "a" };
    const costing = { _id: new mongoose.Types.ObjectId() };
    const version = { _id: new mongoose.Types.ObjectId(), versionNumber: 2 };
    const base = {
      claim: { claimId: "d".repeat(64), target: "costing:x", requestHash: "h1" },
      operation: "COSTING_LEGACY_IMPORT", costing, version, mandatory: true,
    };
    await recordClaimReceipt(ctx, base);

    const cases = [
      ["DIFFERENT_COSTING", { ...base, costing: { _id: new mongoose.Types.ObjectId() } }],
      ["DIFFERENT_VERSION", { ...base, version: { _id: new mongoose.Types.ObjectId(), versionNumber: 3 } }],
      ["DIFFERENT_TARGET", { ...base, claim: { ...base.claim, target: "costing:other" } }],
      ["DIFFERENT_PAYLOAD", { ...base, claim: { ...base.claim, requestHash: "h2" } }],
      ["DIFFERENT_OPERATION", { ...base, operation: "COSTING_VERSION_CREATE" }],
    ];
    for (const [reason, args] of cases) {
      await expect(recordClaimReceipt(ctx, args)).rejects.toMatchObject({
        code: "IDEMPOTENCY_KEY_REUSED", details: expect.objectContaining({ reason }),
      });
    }
    /* Nothing was overwritten by any of them. */
    const stored = await CostingClaim.findOne({ companyId: co._id }).lean();
    expect(String(stored.versionId)).toBe(String(version._id));
    expect(stored.requestHash).toBe("h1");
  });

  test("a receipt for the CREATING key may fail without failing the import", async () => {
    /* That key is bound by the version's own provenance, written in the same
       insert — the receipt is only a uniform lookup. */
    const co = await company("CreatorBestEffort");
    const me = await admin([]);
    await savePolicy(me, co);
    const id = await enquiryCosting(me, co);

    jest.spyOn(CostingClaim, "create").mockRejectedValueOnce(new Error("connection reset"));
    const r = await importLegacy(me, co, id, newKey());
    jest.restoreAllMocks();

    expect(r.status).toBe(201);
    const version = await CostingVersion.findOne({ costingId: id, versionNumber: 2 }).lean();
    expect(version.provenance.creationClaimId).toEqual(expect.any(String));
    expect(await CostingClaim.countDocuments({ companyId: co._id })).toBe(0);
  });

  test("a receipt is a pointer, never an authority: another company cannot use it", async () => {
    const mine = await company("AliasTenantA");
    const theirs = await company("AliasTenantB");
    const meA = await admin([mine]);
    const meB = await admin([theirs]);
    await call("/policy/current", { method: "PUT", token: meA.token, company: mine._id, body: POLICY });
    await call("/policy/current", { method: "PUT", token: meB.token, company: theirs._id, body: POLICY });

    const id = await adhocCosting(meA, mine, "Theirs to find");
    const key = newKey();
    await calculateVersion(meA, mine, id, key);

    /* The same key, from another company's actor, is a DIFFERENT claim (the
       company is hashed into it) and the costing is not theirs to see. */
    const cross = await calculateVersion(meB, theirs, id, key);
    expect(cross.status).toBe(404);
    expect(await CostingClaim.countDocuments({ companyId: theirs._id })).toBe(0);
  });
});

/* ═══ 2 · THE TARGET IS STORED, AND IS THE SERVER'S ══════════════════════ */

describe("creationClaimTarget", () => {
  /* ── AND THE FIELD ITSELF IS ASSERTED WHERE IT IS WRITTEN ─────────────
     "a manual version stores costing:<id>" sat here. The schema declared the
     field and no code path wrote it — always "", so the cross-costing check
     leaned entirely on costingId — and the retired route's middleware was
     what finally wrote it.

     The orchestration writes it now, and has to: its creation claim hashes
     the SUBJECT into the key, so the target is what the claim is a claim ON.
     `sales-estimate-preparation.test.js` asserts both halves against a world
     that HAS a confirmed brief, which is the only world that can produce a
     prepared version at all. */


  /* ── AND A TEST ABOUT A BODY-SUPPLIED TARGET USED TO SIT HERE ──────────
     It posted `target`, `claimTarget` and `costingId` naming a DIFFERENT
     costing and asserted the stored target was the URL's, not the body's.

     No body reaches a calculation any more: the route refuses a browser
     client, and the orchestration composes the claim itself from the enquiry
     it resolved. There is no caller-supplied value left to ignore, which is a
     stronger answer than ignoring one. The claim that the target is derived
     from the subject rather than from anything a caller says is asserted in
     `sales-estimate-preparation.test.js` ("one key pressed on two enquiries is
     two estimates, not one handed over twice"). */

  test("a version with no stored target still recovers its own costing, and only its own", async () => {
    /* Versions created before this fix carry no target. Treating that absence
       as a mismatch would turn every one of them into a permanent 409, so the
       comparison falls back to costingId — which is exactly as strict about
       the thing that matters. */
    const { claimMismatch } = require("../../services/centralCosting/versionCreation.service");
    const mine = new mongoose.Types.ObjectId();
    const theirs = new mongoose.Types.ObjectId();
    const legacyVersion = {
      costingId: mine,
      provenance: { creationClaimTarget: "", creationRequestHash: "h1" },
    };

    expect(claimMismatch(legacyVersion, { _id: mine }, { target: "costing:x", requestHash: "h1" })).toBeNull();
    expect(claimMismatch(legacyVersion, { _id: theirs }, { target: "costing:x", requestHash: "h1" }))
      .toBe("DIFFERENT_COSTING");
  });
});

/* ═══ 3 · CREDITS MAY REDUCE A COST, NOT INVERT IT ═══════════════════════ */

describe("negative net cost", () => {
  const enginePolicy = {
    baseCurrency: "INR", roundingMode: "HALF_UP", sellingPriceIncrementMinor: 1,
    /* Handed straight to `calculate()`, which reads all three as required and
       solves every price break from them. Not a costing-policy BODY — the
       Board owns those fields now, and this is where the resolved band
       arrives. */
    floorMarkupPercent: "25",
  };
  const line = (lineKey, amountMinor) => ({
    lineKey, category: "MATERIAL", behaviour: "PER_UNIT", label: lineKey,
    unitRate: { amountMinor, currency: "INR" }, quantityPerUnit: "1",
  });
  const engine = (lines) => calculate({
    policy: enginePolicy, lines,
    scenarios: [{ key: "q100", label: "100 pcs", quantity: "100", isPrimary: true }],
  });

  test("the pure engine refuses it, and says which scenario and what total", () => {
    let err;
    try { engine([line("goods", 10000), line("rebate", -15000)]); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(CostingEngineError);
    expect(err.details.reason).toBe("NEGATIVE_NET_COST");
    expect(err.details.scenarioKey).toBe("q100");
    expect(err.details.totalCostMinor).toBe(-500000);
    /* And no price was derived from it — the check runs before pricing. */
    expect(err.message).toMatch(/credits/i);
  });

  test("a rebate that leaves the total positive still calculates", () => {
    const s = engine([line("goods", 10000), line("rebate", -4000)]).scenarios[0];
    expect(s.totalCostMinor).toBe(600000);
    expect(s.unitCostMinor).toBe(6000);
    expect(s.floor.floorPriceMinor).toBeGreaterThan(0);
  });

  test("a total of exactly zero is valid and distinct from missing", () => {
    const s = engine([line("goods", 10000), line("rebate", -10000)]).scenarios[0];
    expect(s.totalCostMinor).toBe(0);
    expect(s.unitCostMinor).toBe(0);
    /* ── A FREE GARMENT HAS A FLOOR OF NIL, WHICH IS AN ANSWER ──────
       And no percentage return, because that would divide by zero. */
    expect(s.floor.floorPriceMinor).toBe(0);
    expect(s.floor.realisedReturnOnPricePercent).toBeNull();
  });

  /* ── AND THE ROUTE HALF OF THIS SECTION IS RETIRED ────────────────────
     A buyer rebate was sent as a declared override with a negative rate, and
     the route answered `NEGATIVE_NET_COST` — a costing that would otherwise
     have recommended paying the customer. The test then followed the
     IDEMPOTENCY KEY through the refusal: the claim released rather than
     burnt, the same request refused freshly rather than replayed, a corrected
     payload unable to re-aim the spent key.

     No line reaches the engine from a request any more, and the route that
     carried one refuses a browser client outright — so none of that sequence
     can be produced. The guard itself is the ENGINE's and is tested directly
     above, where a negative line goes straight to `calculate`. The key
     lifecycle is the middleware's and is still exercised by the routes that
     still take a write: `legacy-import`, `submit` and `approve`. */

});

/* ═══ 4 · THE POLICY SCREEN NO LONGER DESCRIBES THE OLD BEHAVIOUR ════════ */

describe("policy screen copy", () => {
  /* Reading the frontend source from a backend test is unusual, and it is the
     only way to prove a claim about copy that no backend response carries.
     Skipped rather than failed where the sibling repository is not checked
     out, so a backend-only clone does not report a defect that is not there.
     Whitespace is normalised because the sentence is wrapped across JSX
     lines. */
  const panelPath = path.join(__dirname, "../../../grav-cms/components/costing/CostingPolicyPanel.js");
  const present = fs.existsSync(panelPath);
  const panel = present ? fs.readFileSync(panelPath, "utf8").replace(/\s+/g, " ") : "";
  const it = present ? test : test.skip;

  it("the obsolete promise is gone", () => {
    /* It told the reader a price would come out equal to its cost until a
       policy was saved. The server now refuses to calculate at all, so the
       sentence promised a result nobody would get. */
    expect(panel).not.toContain("selling price equals its cost");
    expect(panel).not.toContain("margins are zero — so a selling price");
  });

  it("and what replaces it says what actually happens", () => {
    expect(panel).toContain("Costings cannot calculate a selling price until this policy is saved");
    /* An explicitly chosen 0% is still valid, and the copy says so rather than
       leaving a reader to think zero margins are impossible. */
    expect(panel).toContain("Setting a 0% margin here is a valid choice");
  });
});
