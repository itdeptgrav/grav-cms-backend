// test/costing/costing-foundation.route.test.js
//
// Central Costing — Chunk 1. THE BOUNDARY, PROVED.
//
// ── WHAT THIS PINS ──────────────────────────────────────────────────────────
// Chunk 1 builds no calculator, so there is no arithmetic to test. What it
// builds is a contract about WHO may reach WHAT, and that contract is only
// worth anything if it is exercised: every claim below is one the chunk makes
// in prose somewhere, checked against the running route.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const Employee = require("../../models/Employee");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const DeptUser = require("../../models/Access/DeptUser");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const Costing = require("../../models/CMS_Models/Costing/Costing");
const { seedSourceBacked, configureProduction } = require("./helpers/sourceBacked");
const CostingVersion = require("../../models/CMS_Models/Costing/CostingVersion");
const capabilityService = require("../../services/centralCosting/capabilities");
const { CAPABILITIES } = capabilityService;

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

const newKey = () => `cost-${++seq}-${Math.random().toString(36).slice(2)}`;

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
    let body = null;
    /* An unrouted method answers with Express's HTML 404, which is itself the
       proof that no such endpoint exists — so a non-JSON body is recorded,
       not thrown on. */
    try { body = raw ? JSON.parse(raw) : null; } catch { body = { nonJson: true }; }
    return { status: r.status, replayed: r.headers.get("Idempotency-Replayed"), body };
  });

const company = (name) =>
  Acc_Company.create({ companyName: `${name} ${++seq}`, booksFromDate: new Date("2026-04-01") });

/**
 * A person, their grant and their membership.
 *
 * `grant: null` is the case the chunk cares most about — a perfectly valid
 * employee token with no costing authority at all.
 */
async function person({ companies = [], grant = null, role = "approver", admin = false, name = "P" } = {}) {
  const n = ++seq;
  const email = `costing${n}@test.example`;
  const emp = await Employee.create({
    firstName: name, lastName: `L${n}`, email, biometricId: `CST${n}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  if (grant) await DepartmentRole.create({ departmentSlug: grant, email, role, isActive: true });
  if (admin) {
    await DeptUser.create({
      name, email, passwordHash: "x", isAdmin: true, isActive: true,
      departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
    });
  }
  for (const co of companies) {
    await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: name });
  }
  return {
    emp, email,
    token: jwt.sign(
      { id: String(emp._id), email, name, role: "employee", employeeId: emp.biometricId },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
    ),
  };
}

/* ── THE BODY THAT CREATES A COSTING ─────────────────────────────────────
 * It used to be `{ context: { type: "ADHOC" }, label: "..." }` — no enquiry,
 * no technical record, no policy, and an approvable cost at the end of it.
 * Manual creation is closed, so the body now names a real enquiry product and
 * the fixture seeds what stands behind it.
 *
 * Every assertion in this file is about the CREATE — its claim, its key, its
 * tenancy, its provenance, its visibility — so the context only has to be
 * real, not interesting. */
const sourceBackedBody = async (co, over = {}) => {
  const seeded = await seedSourceBacked(co._id);
  await configureProduction(co._id);
  return { context: seeded.context, ...over };
};

const create = async (actor, co, body = null, key = newKey()) =>
  call("/", {
    method: "POST", token: actor.token, company: co?._id, idempotencyKey: key,
    body: body || (co ? await sourceBackedBody(co) : {}),
  });

/** Somebody who can do everything: the existing platform-admin authority. */
const admin = (companies) => person({ companies, admin: true, name: "Admin" });
/** Somebody who can do nothing: authenticated, and that is all. */
const nobody = (companies) => person({ companies, grant: null, name: "Nobody" });
/** A Sales grant: approved commercial output, and nothing else. */
const salesReader = (companies) => person({ companies, grant: "sales", role: "owner", name: "Sales" });

/* ═══ 1 · AUTHORISED CREATION ════════════════════════════════════════════ */

describe("creating a costing", () => {
  test("an authorised actor gets a costing and version 1", async () => {
    const co = await company("Alpha");
    const me = await admin([co]);

    const r = await create(me, co);
    expect(r.status).toBe(201);
    expect(r.body.success).toBe(true);

    expect(r.body.costing.status).toBe("DRAFT");
    expect(r.body.costing.currentVersion.number).toBe(1);
    /* The label is the server's, taken from the context — it used to be
       whatever the creator typed, which is how two costings for one product
       ended up unrecognisable to each other. */
    expect(r.body.costing.contextSnapshot.label).toMatch(/^Oxford Shirt \d+ — ENQ-SB-\d+$/);
    expect(r.body.versions).toHaveLength(1);
    expect(r.body.versions[0].versionNumber).toBe(1);
    expect(r.body.versions[0].status).toBe("DRAFT");
    expect(r.body.versions[0].baseCurrency).toBe("INR");
    /* No calculator ran, and the payload says so rather than showing a zero. */
    expect(r.body.versions[0].calculationSchemaVersion).toBe(0);
    expect(r.body.versions[0].cost.calculated).toBe(false);
    expect(r.body.versions[0].cost.sourceReferences).toEqual([]);
    expect(r.body.versions[0].scenarios).toEqual([]);

    expect(await Costing.countDocuments({})).toBe(1);
    expect(await CostingVersion.countDocuments({})).toBe(1);
  });

  test("company and actor are server-derived, never taken from the payload", async () => {
    const co = await company("Beta");
    const me = await admin([co]);

    const r = await create(me, co, await sourceBackedBody(co, {
      /* Everything a client might hope to set. */
      status: "APPROVED",
      versionNumber: 99,
      currentVersionNumber: 99,
      createdByActorId: "somebody-else",
      createdByActorName: "Somebody Else",
      calculationSchemaVersion: 7,
    }));
    expect(r.status).toBe(201);

    const stored = await Costing.findOne({}).lean();
    expect(String(stored.companyId)).toBe(String(co._id));
    expect(stored.status).toBe("DRAFT");
    expect(stored.currentVersionNumber).toBe(1);
    expect(stored.createdByActorId).toBe(String(me.emp._id));
    expect(stored.createdByActorName).toBe("Admin");

    const version = await CostingVersion.findOne({}).lean();
    expect(version.versionNumber).toBe(1);
    expect(version.calculationSchemaVersion).toBe(0);
    expect(String(version.companyId)).toBe(String(co._id));
    expect(version.provenance.createdByActorId).toBe(String(me.emp._id));
  });

  test("a payload naming another company is refused, not silently substituted", async () => {
    const co = await company("Gamma");
    const other = await company("Delta");
    const me = await admin([co]);

    const r = await create(me, co, await sourceBackedBody(co, { companyId: String(other._id) }));
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("TENANT_MISMATCH");
    expect(await Costing.countDocuments({})).toBe(0);
  });
});

/* ═══ 2 · AUTHENTICATION ALONE GRANTS NOTHING ════════════════════════════ */

describe("authentication is not authorisation", () => {
  test("no token is refused everywhere", async () => {
    const co = await company("Eps");
    const me = await admin([co]);
    const made = await create(me, co);
    const id = made.body.costing.id;

    for (const [path, opts] of [
      ["/", {}],
      [`/${id}`, {}],
      [`/${id}/versions`, {}],
      ["/", { method: "POST", body: { context: { type: "ENQUIRY_STYLE", primaryId: String(new mongoose.Types.ObjectId()), externalKey: "Blazer" } }, idempotencyKey: newKey() }],
    ]) {
      const r = await call(path, opts);
      expect(r.status).toBe(401);
      expect(r.body?.success).not.toBe(true);
    }
  });

  test("a valid employee token with no costing grant reaches nothing", async () => {
    const co = await company("Zeta");
    const me = await admin([co]);
    const made = await create(me, co);
    const id = made.body.costing.id;

    const outsider = await nobody([co]);
    for (const [path, opts] of [
      ["/", {}],
      [`/${id}`, {}],
      [`/${id}/versions`, {}],
      ["/", { method: "POST", body: { context: { type: "ENQUIRY_STYLE", primaryId: String(new mongoose.Types.ObjectId()), externalKey: "Blazer" } }, idempotencyKey: newKey() }],
    ]) {
      const r = await call(path, { ...opts, token: outsider.token, company: co._id });
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe("FORBIDDEN");
    }
    expect(await Costing.countDocuments({})).toBe(1);
  });

  test("a Sales grant carries approved output and the right to ASK — never cost, margin or write", async () => {
    /* ── WHAT CHANGED, AND WHAT DID NOT ──────────────────────────────────
       Sales gained `costing.prepare` from `editor` upward: the right to ask
       Central Costing to prepare or refresh an estimate. It was added because
       the alternative was `costing.draft.write`, which carries `cost.read` and
       belongs to the people who maintain costings.

       Everything this test was written to protect is unchanged. Preparing is
       not reading: a Sales owner may cause a costing to exist and may still
       see none of its build-up, none of its margin, and no supplier's rate. */
    const sales = await salesReader([]);
    const caps = capabilityService.capabilitiesFromGrants(
      [{ departmentSlug: "sales", role: "owner" }], false,
    );
    expect(caps.capabilities.sort()).toEqual([
      CAPABILITIES.OUTPUT_READ, CAPABILITIES.PREPARE,
      /* A Sales owner may also ask for a commercial decision and take an
         ordinary one. Neither is a READING grant — the assertions below
         are unchanged. */
      CAPABILITIES.COMMERCIAL_SUBMIT, CAPABILITIES.COMMERCIAL_APPROVE,
    ].sort());
    expect(caps.capabilities).not.toContain(CAPABILITIES.COMMERCIAL_EXCEPTION);
    expect(caps.capabilities).not.toContain(CAPABILITIES.COST_READ);
    expect(caps.capabilities).not.toContain(CAPABILITIES.MARGIN_READ);
    expect(caps.capabilities).not.toContain(CAPABILITIES.DRAFT_WRITE);
    expect(caps.capabilities).not.toContain(CAPABILITIES.APPROVE);
    expect(caps.capabilities).not.toContain(CAPABILITIES.POLICY_MANAGE);

    /* And a Sales VIEWER gains nothing at all — preparing is a write. */
    const viewer = capabilityService.capabilitiesFromGrants(
      [{ departmentSlug: "sales", role: "viewer" }], false,
    );
    expect(viewer.capabilities).toEqual([CAPABILITIES.OUTPUT_READ]);
    expect(sales.email).toBeTruthy();
  });
});

/* ═══ 3 · WHAT A SALES-ONLY READER SEES OF A DRAFT ═══════════════════════ */

describe("a Sales-only reader and an internal draft", () => {
  test("cannot create, and cannot tell a draft from a costing that does not exist", async () => {
    const co = await company("Eta");
    const me = await admin([co]);
    const made = await create(me, co);
    const id = made.body.costing.id;

    const sales = await salesReader([co]);

    /* Writing is refused by capability. */
    const write = await create(sales, co);
    expect(write.status).toBe(403);

    /* Reading a DRAFT is refused as MISSING — not as forbidden, which would
       confirm that somebody is costing this. */
    const detail = await call(`/${id}`, { token: sales.token, company: co._id });
    const versions = await call(`/${id}/versions`, { token: sales.token, company: co._id });
    const absent = await call(`/${new mongoose.Types.ObjectId()}`, { token: sales.token, company: co._id });

    expect(detail.status).toBe(404);
    expect(versions.status).toBe(404);
    expect(detail.body).toEqual(absent.body);
    expect(versions.body).toEqual(absent.body);

    /* And the list does not leak it either. */
    const list = await call("/", { token: sales.token, company: co._id });
    expect(list.status).toBe(200);
    expect(list.body.costings).toEqual([]);
  });
});

/* ═══ 4 · COST DOES NOT IMPLY MARGIN ═════════════════════════════════════ */

describe("the visibility layer", () => {
  /* No department grant yields cost-without-margin today — that mapping is an
     open business decision. The separation must still hold at the ROUTE, so
     the capability resolution (and only that) is stood in for. */
  const withCapabilities = (list) =>
    jest.spyOn(capabilityService, "resolveCapabilities")
      .mockResolvedValue({ capabilities: list, via: ["test"], isAdmin: false });

  test("an internal-cost reader receives cost and no margin", async () => {
    const co = await company("Theta");
    const me = await admin([co]);
    const made = await create(me, co, await sourceBackedBody(co, {
      sourceReferences: [{
        sourceType: "MANUAL_ENTRY",
        sourceKey: "fabric",
        label: "Shell fabric, indicative",
        snapshot: [{ key: "unitPrice", money: { amountMinor: 41250, currency: "INR" } }],
      }],
    }));
    expect(made.status).toBe(201);
    const id = made.body.costing.id;

    const reader = await person({ companies: [co], name: "Coster" });
    withCapabilities([CAPABILITIES.COST_READ]);

    const r = await call(`/${id}`, { token: reader.token, company: co._id });
    expect(r.status).toBe(200);

    const v = r.body.versions[0];
    expect(v.cost.sourceReferences[0].snapshot[0].money).toEqual({
      amountMinor: 41250, currency: "INR", display: "412.50 INR",
    });
    /* Withheld blocks are ABSENT, not nulled — a null would say "there is no
       margin", which is a different and untrue statement. */
    expect(v).not.toHaveProperty("margin");
    expect(v).not.toHaveProperty("output");
    expect(r.body.visibility.withheld.sort()).toEqual(["margin", "output"]);
  });

  test("a margin reader who may not see cost receives neither cost nor sources", async () => {
    const co = await company("Iota");
    const me = await admin([co]);
    const made = await create(me, co, await sourceBackedBody(co, {
      sourceReferences: [{ sourceType: "MANUAL_ENTRY", sourceKey: "fabric" }],
    }));
    const id = made.body.costing.id;

    const reader = await person({ companies: [co], name: "Margin" });
    withCapabilities([CAPABILITIES.MARGIN_READ]);

    const r = await call(`/${id}`, { token: reader.token, company: co._id });
    expect(r.status).toBe(200);
    const v = r.body.versions[0];
    expect(v).not.toHaveProperty("cost");
    expect(v.margin.calculated).toBe(false);
    expect(v.margin.band).toBeNull();
    /* A count is not a disclosure; what the source SAID is, and that is gone. */
    expect(v.sourceReferenceCount).toBe(1);
    expect(JSON.stringify(r.body)).not.toContain("fabric");
  });
});

/* ═══ 5 · TENANCY ════════════════════════════════════════════════════════ */

describe("company boundary", () => {
  test("a foreign-company id is indistinguishable from one that never existed", async () => {
    const a = await company("Kappa");
    const b = await company("Lambda");
    const mineA = await admin([a]);
    const mineB = await admin([b]);

    const made = await create(mineA, a);
    const foreignId = made.body.costing.id;
    const neverExisted = String(new mongoose.Types.ObjectId());

    for (const path of ["", "/versions"]) {
      const foreign = await call(`/${foreignId}${path}`, { token: mineB.token, company: b._id });
      const missing = await call(`/${neverExisted}${path}`, { token: mineB.token, company: b._id });
      const malformed = await call(`/not-an-id${path}`, { token: mineB.token, company: b._id });

      expect(foreign.status).toBe(404);
      expect(foreign.body).toEqual(missing.body);
      expect(malformed.body).toEqual(missing.body);
    }

    const list = await call("/", { token: mineB.token, company: b._id });
    expect(list.body.costings).toEqual([]);
  });

  test("no proven membership fails closed", async () => {
    await company("Mu");
    await company("Nu"); // two companies ⇒ the single-company rule cannot apply
    const stranger = await admin([]); // full capabilities, no membership

    const r = await call("/", { token: stranger.token });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("TENANT_MEMBERSHIP_UNPROVEN");

    const write = await create(stranger, null);
    expect(write.status).toBe(403);
    expect(await Costing.countDocuments({})).toBe(0);
  });

  test("ambiguous membership fails closed until the actor chooses one of their own", async () => {
    const a = await company("Xi");
    const b = await company("Omicron");
    const both = await admin([a, b]);

    const unchosen = await call("/", { token: both.token });
    expect(unchosen.status).toBe(409);
    expect(unchosen.body.error.code).toBe("COMPANY_SELECTION_REQUIRED");

    /* Naming a company they do NOT hold is refused the same way as one that
       does not exist — the header selects among memberships, it never grants. */
    const outside = await company("Pi");
    const foreign = await call("/", { token: both.token, company: outside._id });
    expect(foreign.status).toBe(403);
    expect(foreign.body.error.code).toBe("TENANT_MEMBERSHIP_UNPROVEN");

    const chosen = await call("/", { token: both.token, company: b._id });
    expect(chosen.status).toBe(200);
    expect(chosen.body.visibility.companyId).toBe(String(b._id));
  });

  test("the single-company deployment rule is marked, not hidden", async () => {
    const only = await company("Rho");
    const me = await admin([]); // no membership rows exist at all
    /* Seeded against the only company there is — which is the point: the
       actor names no company and the server resolves it. */
    const r = await create(me, null, await sourceBackedBody(only));
    expect(r.status).toBe(201);
    expect(r.body.visibility.membershipSource).toBe("SINGLE_COMPANY_DEPLOYMENT");
    expect(r.body.visibility.companyId).toBe(String(only._id));
  });
});

/* ═══ 6 · IDEMPOTENCY ════════════════════════════════════════════════════ */

describe("a retry is not a second costing", () => {
  test("the same key and payload replays instead of creating again", async () => {
    const co = await company("Sigma");
    const me = await admin([co]);
    const key = newKey();

    const body = await sourceBackedBody(co);
    const first = await create(me, co, body, key);
    const retry = await create(me, co, body, key);

    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    expect(retry.replayed).toBe("true");
    expect(retry.body.costing.id).toBe(first.body.costing.id);
    expect(await Costing.countDocuments({})).toBe(1);
    expect(await CostingVersion.countDocuments({})).toBe(1);
  });

  test("the same key with a different payload is refused loudly", async () => {
    const co = await company("Tau");
    const me = await admin([co]);
    const key = newKey();

    await create(me, co, await sourceBackedBody(co), key);
    const different = await create(me, co, await sourceBackedBody(co), key);
    expect(different.status).toBe(409);
    expect(different.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(await Costing.countDocuments({})).toBe(1);
  });

  test("a refused request does not become a replayable success", async () => {
    const co = await company("Upsilon");
    const me = await admin([co]);
    const key = newKey();

    /* The refusal must not be stored as the key's answer: sending the same
       thing again is refused again, freshly, rather than replayed — and a
       later corrected payload is a DIFFERENT request, which the key contract
       answers as a reuse conflict rather than silently accepting. */
    const bad = await create(me, co, { context: { type: "WISHFUL" } }, key);
    expect(bad.status).toBe(400);

    const again = await create(me, co, { context: { type: "WISHFUL" } }, key);
    expect(again.status).toBe(400);
    expect(again.replayed).toBeNull();

    const corrected = await create(me, co, await sourceBackedBody(co), key);
    expect(corrected.status).toBe(409);
    expect(corrected.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");

    /* A fresh key for the corrected payload works, and only one costing
       exists at the end of all of it. */
    const good = await create(me, co, await sourceBackedBody(co), newKey());
    expect(good.status).toBe(201);
    expect(await Costing.countDocuments({})).toBe(1);
  });

  test("a create without an idempotency key is refused rather than run unprotected", async () => {
    const co = await company("Phi");
    const me = await admin([co]);
    const r = await call("/", { method: "POST", token: me.token, company: co._id, body: await sourceBackedBody(co) });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect(await Costing.countDocuments({})).toBe(0);
  });
});

/* ═══ 7 · ATOMICITY ══════════════════════════════════════════════════════ */

describe("a costing and its version 1, or neither", () => {
  test("a failed parent insert leaves no version behind", async () => {
    const co = await company("Chi");
    const me = await admin([co]);

    jest.spyOn(Costing, "create").mockRejectedValueOnce(new Error("simulated write failure"));

    const r = await create(me, co);
    expect(r.status).toBeGreaterThanOrEqual(400);

    expect(await Costing.countDocuments({})).toBe(0);
    expect(await CostingVersion.countDocuments({})).toBe(0);
  });
});

/* ═══ 8 · IMMUTABILITY AND VERSION NUMBERING ═════════════════════════════ */

describe("a persisted version cannot be rewritten", () => {
  test("there is no endpoint that edits one", async () => {
    const co = await company("Psi");
    const me = await admin([co]);
    const made = await create(me, co);
    const id = made.body.costing.id;

    for (const method of ["PUT", "PATCH", "DELETE"]) {
      for (const path of [`/${id}`, `/${id}/versions`, `/${id}/versions/1`]) {
        const r = await call(path, { method, token: me.token, company: co._id, body: { status: "APPROVED" } });
        expect(r.status).toBe(404); // no such route
      }
    }
  });

  test("the model refuses a content change through save() and through update()", async () => {
    const co = await company("Omega");
    const me = await admin([co]);
    await create(me, co, await sourceBackedBody(co, {
      sourceReferences: [{ sourceType: "MANUAL_ENTRY", sourceKey: "fabric", label: "original" }],
    }));

    const version = await CostingVersion.findOne({});
    version.baseCurrency = "USD";
    await expect(version.save()).rejects.toThrow(/immutable/i);

    await expect(
      CostingVersion.updateOne({ _id: version._id }, { $set: { "sourceReferences.0.label": "rewritten" } }),
    ).rejects.toThrow(/immutable/i);

    await expect(
      CostingVersion.findOneAndUpdate({ _id: version._id }, { $set: { versionNumber: 5 } }),
    ).rejects.toThrow(/immutable/i);

    const fresh = await CostingVersion.findById(version._id).lean();
    expect(fresh.baseCurrency).toBe("INR");
    expect(fresh.versionNumber).toBe(1);
    expect(fresh.sourceReferences[0].label).toBe("original");

    /* Status is frozen too, as of the hardening pass: the approval transition
       is a controlled act (approver, decision, reason, policy check) that
       Chunk 6 owns, and leaving the field writable meant the only thing
       between a draft and an "approved" costing was that nobody had written
       the line yet. */
    await expect(
      CostingVersion.updateOne({ _id: version._id }, { $set: { status: "APPROVED" } }),
    ).rejects.toThrow(/immutable/i);
  });

  test("version numbers are unique within a costing and not across companies", async () => {
    const co = await company("Alpha2");
    const me = await admin([co]);
    const made = await create(me, co);
    const costingId = made.body.costing.id;

    await CostingVersion.init(); // the unique index IS the guarantee

    await expect(
      CostingVersion.create({
        companyId: co._id, costingId, versionNumber: 1, baseCurrency: "INR",
        provenance: { origin: "CORRECTION", createdAt: new Date() },
      }),
    ).rejects.toMatchObject({ code: 11000 });

    /* Version 2 is how a correction is made — the earlier one is untouched. */
    const two = await CostingVersion.create({
      companyId: co._id, costingId, versionNumber: 2, baseCurrency: "INR",
      provenance: { origin: "CORRECTION", createdAt: new Date(), supersedesVersionNumber: 1 },
    });
    expect(two.versionNumber).toBe(2);

    /* Another company's costing has its own version 1: uniqueness is scoped,
       never global. */
    const otherCo = await company("Beta2");
    const otherAdmin = await admin([otherCo]);
    const otherMade = await create(otherAdmin, otherCo);
    expect(otherMade.status).toBe(201);
    expect(otherMade.body.versions[0].versionNumber).toBe(1);

    const list = await call(`/${costingId}/versions`, { token: me.token, company: co._id });
    expect(list.body.versions.map((v) => v.versionNumber)).toEqual([1, 2]);
    expect(list.body.versions[0].provenance.supersedesVersionNumber).toBeNull();
    expect(list.body.versions[1].provenance.supersedesVersionNumber).toBe(1);
  });
});

/* ═══ 9 · INPUT VALIDATION ═══════════════════════════════════════════════ */

describe("malformed input is refused, never repaired", () => {
  /* Each case is a function of a REAL create body, because a valid context is
     no longer a literal — it names an enquiry product that has to exist. The
     malformed field is what each case is about; the context around it just has
     to get past the door. */
  const cases = [
    ["no context at all", () => ({}), "CONTEXT_REQUIRED"],
    ["an unknown context type", () => ({ context: { type: "WISHFUL" } }), "CONTEXT_TYPE_UNKNOWN"],
    ["a malformed id",
      () => ({ context: { type: "ENQUIRY_STYLE", primaryId: "nope", externalKey: "Blazer" } }), "INVALID_OBJECT_ID"],
    ["an enquiry product with no product",
      () => ({ context: { type: "ENQUIRY_STYLE", primaryId: "64b7d1f9c2a4e81234567890" } }),
      "CONTEXT_EXTERNAL_KEY_REQUIRED"],
    ["a currency that is not a currency", (base) => ({ ...base, baseCurrency: "RUPEES" }), "CURRENCY_FORMAT"],
    ["a currency nothing can cost in", (base) => ({ ...base, baseCurrency: "XXX" }), "CURRENCY_UNSUPPORTED"],
    ["an unknown source type",
      (base) => ({ ...base, sourceReferences: [{ sourceType: "VIBES", sourceKey: "x" }] }), "SOURCE_TYPE_UNKNOWN"],
    ["a source that identifies nothing",
      (base) => ({ ...base, sourceReferences: [{ sourceType: "MANUAL_ENTRY" }] }), "SOURCE_IDENTITY_REQUIRED"],
    ["money in major units",
      (base) => ({ ...base, sourceReferences: [{ sourceType: "MANUAL_ENTRY", sourceKey: "x",
        snapshot: [{ key: "p", money: { amountMinor: 412.5, currency: "INR" } }] }] }),
      "AMOUNT_MINOR_NOT_INTEGER"],
    ["money as text",
      (base) => ({ ...base, sourceReferences: [{ sourceType: "MANUAL_ENTRY", sourceKey: "x",
        snapshot: [{ key: "p", money: { amountMinor: "412", currency: "INR" } }] }] }),
      "AMOUNT_MINOR_TYPE"],
    ["money with no currency",
      (base) => ({ ...base, sourceReferences: [{ sourceType: "MANUAL_ENTRY", sourceKey: "x",
        snapshot: [{ key: "p", money: { amountMinor: 412 } }] }] }),
      "CURRENCY_REQUIRED"],
    ["a source amount in another currency than the version's",
      (base) => ({ ...base, baseCurrency: "INR", sourceReferences: [{ sourceType: "MANUAL_ENTRY", sourceKey: "x",
        snapshot: [{ key: "p", money: { amountMinor: 412, currency: "USD" } }] }] }),
      "CURRENCY_MISMATCH"],
    ["a snapshot fact with two values",
      (base) => ({ ...base, sourceReferences: [{ sourceType: "MANUAL_ENTRY", sourceKey: "x",
        snapshot: [{ key: "p", num: 1, text: "one" }] }] }),
      "VALUE_AMBIGUOUS"],
  ];

  test.each(cases)("%s is refused with no record written", async (_label, build, reason) => {
    const co = await company("Val");
    const me = await admin([co]);
    const r = await create(me, co, build(await sourceBackedBody(co)));
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("VALIDATION");
    expect(r.body.error.details.reason).toBe(reason);
    expect(await Costing.countDocuments({})).toBe(0);
    expect(await CostingVersion.countDocuments({})).toBe(0);
  });

  test("a manual costing is refused before any field of it is examined", async () => {
    /* ── WHAT THIS REPLACES ────────────────────────────────────────────────
       A case in the table above: an ad-hoc context carrying a document id was
       refused as CONTEXT_ADHOC_HAS_ID, because an ad-hoc costing references
       nothing. The shape check is unreachable now — the context type is
       refused first, and there is no well-formed ad-hoc body either. The
       original intent, that a malformed manual context is never repaired into
       something creatable, is what the two assertions below hold. */
    const co = await company("NoManual");
    const me = await admin([co]);
    for (const context of [{ type: "ADHOC" }, { type: "ADHOC", primaryId: "64b7d1f9c2a4e81234567890" }]) {
      const r = await create(me, co, { context, label: "Spring blazer, indicative" });
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe("COSTING_ADHOC_CREATION_CLOSED");
      expect(r.body.error.details.reason).toBe("ADHOC_CREATION_CLOSED");
      expect(r.body.error.details.allowed).toEqual(["ENQUIRY_STYLE"]);
    }
    expect(await Costing.countDocuments({})).toBe(0);
    expect(await CostingVersion.countDocuments({})).toBe(0);
  });

  test("zero is a real amount and is not confused with a missing one", async () => {
    const co = await company("Zero");
    const me = await admin([co]);
    const r = await create(me, co, await sourceBackedBody(co, {
      sourceReferences: [{
        sourceType: "MANUAL_ENTRY", sourceKey: "waived",
        snapshot: [{ key: "charge", money: { amountMinor: 0, currency: "INR" } }],
      }],
    }));
    expect(r.status).toBe(201);
    const fact = r.body.versions[0].cost.sourceReferences[0].snapshot[0];
    expect(fact.money.amountMinor).toBe(0);
    expect(fact.money.display).toBe("0.00 INR");
    /* And a source with no snapshot at all keeps an EMPTY list, not a zero. */
    const bare = await create(me, co, await sourceBackedBody(co, {
      sourceReferences: [{ sourceType: "MANUAL_ENTRY", sourceKey: "unknown-rate" }],
    }));
    expect(bare.body.versions[0].cost.sourceReferences[0].snapshot).toEqual([]);
  });
});

/* ═══ CHUNK 4C · CHOOSING WHAT TO COST ═══════════════════════════════════ */

const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
const Account = require("../../models/CMS_Models/Sales/Account");
const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");

/* An enquiry hangs off a journey. Created here rather than stubbed, so the
   picker is exercised against the real shape. */
const journeyIn = (co) =>
  SalesJourney.create({
    journeyId: `SJ-${++seq}`, companyId: co._id,
    accountId: new mongoose.Types.ObjectId(), ownerId: new mongoose.Types.ObjectId(),
    ownerName: "Owner", name: `Journey ${seq}`, isActive: true,
  });

describe("the enquiry-product picker", () => {
  /* ── WHY THIS EXISTS ──────────────────────────────────────────────────
     Starting an enquiry costing required typing a raw Mongo `_id` and the
     product name exactly as the enquiry spells it. Nobody can do that — and
     it made the BROWSER responsible for naming a record correctly, which is
     a client that can name a record it was never shown. */

  const own = (co, over = {}) =>
    Account.create({
      companyName: over.customer || `Buyer ${++seq}`,
      companyId: co._id,
      companyOwnership: { source: "MEMBERSHIP_RECORD", resolvedAt: new Date(), proven: true },
      isActive: true,
    });

  async function enquiryIn(co, { customer, products, title = "Spring range" } = {}) {
    const account = await own(co, { customer });
    const e = await Enquiry.create({
      enquiryId: `ENQ-${++seq}`,
      journeyId: (await journeyIn(co))._id,
      accountId: account._id,
      companyId: co._id,
      title,
      isActive: true,
      products: (products || [{ product: `Oxford Shirt ${seq}`, quantity: 500, colour: "White" }]),
    });
    return { enquiry: await Enquiry.findById(e._id).lean(), account };
  }

  const look = (actor, co, qs = "") =>
    call(`/lookup/enquiry-products${qs}`, { token: actor.token, company: co?._id });

  test("eligible products carry the identifiers the create needs, and the words a person reads", async () => {
    const co = await company("Pick");
    const me = await admin([co]);
    const { enquiry, account } = await enquiryIn(co, {
      customer: "Northwind Uniforms",
      products: [{ product: "Oxford Shirt", quantity: 500, colour: "White", sizeRange: "S-XXL" }],
    });

    const r = await look(me, co);
    expect(r.status).toBe(200);
    const row = r.body.products.find((p) => p.product === "Oxford Shirt");
    expect(row).toBeTruthy();

    /* The server-owned identifiers, exactly as POST /api/costings expects
       them. The browser echoes these and constructs neither. */
    expect(row.context).toEqual({
      type: "ENQUIRY_STYLE", primaryId: String(enquiry._id), externalKey: "Oxford Shirt",
    });
    /* And what somebody actually recognises. */
    expect(row.enquiryNumber).toBe(enquiry.enquiryId);
    expect(row.customerName).toBe(account.companyName);
    expect(row.quantity).toBe(500);
    expect(row.variant).toBe("White · S-XXL");
    expect(row.existingCosting).toBeNull();
  });

  test("one row per product, because one product is one costing", async () => {
    const co = await company("Multi");
    const me = await admin([co]);
    await enquiryIn(co, {
      products: [
        { product: "Polo", quantity: 200 },
        { product: "Cap", quantity: 1000 },
      ],
    });
    const r = await look(me, co);
    const names = r.body.products.map((p) => p.product).sort();
    expect(names).toEqual(["Cap", "Polo"]);
  });

  test("another company's enquiries are absent, not refused", async () => {
    const mine = await company("Mine");
    const theirs = await company("Theirs");
    const me = await admin([mine]);
    await enquiryIn(theirs, { products: [{ product: "Foreign Jacket", quantity: 10 }] });
    await enquiryIn(mine, { products: [{ product: "Own Jacket", quantity: 10 }] });

    const r = await look(me, mine);
    expect(r.status).toBe(200);
    const names = r.body.products.map((p) => p.product);
    expect(names).toContain("Own Jacket");
    /* Not "unavailable" — absent, exactly as everywhere else in this domain.
       A picker that listed it as blocked would confirm it exists. */
    expect(names).not.toContain("Foreign Jacket");
    expect(JSON.stringify(r.body)).not.toContain("Foreign Jacket");
  });

  test("searching by enquiry number, customer and product all work", async () => {
    const co = await company("Search");
    const me = await admin([co]);
    const { enquiry } = await enquiryIn(co, {
      customer: "Zenith Workwear",
      products: [{ product: "Hi-Vis Vest", quantity: 300 }],
    });
    await enquiryIn(co, { customer: "Other Buyer", products: [{ product: "Apron", quantity: 50 }] });

    const byNumber = await look(me, co, `?q=${encodeURIComponent(enquiry.enquiryId)}`);
    expect(byNumber.body.products.map((p) => p.product)).toEqual(["Hi-Vis Vest"]);

    const byProduct = await look(me, co, "?q=hi-vis");
    expect(byProduct.body.products.map((p) => p.product)).toEqual(["Hi-Vis Vest"]);

    /* Case-insensitive, because nobody types a customer name exactly. */
    const byTitle = await look(me, co, "?q=SPRING");
    expect(byTitle.body.products.length).toBeGreaterThan(0);
  });

  test("a reader who cannot create gets no list to create from", async () => {
    const co = await company("NoWrite");
    const reader = await salesReader([co]);
    const r = await look(reader, co);
    expect(r.status).toBe(403);
    expect(r.body.products).toBeUndefined();

    const none = await nobody([co]);
    expect((await look(none, co)).status).toBe(403);
  });

  test("a product already being costed says so, with the costing to open", async () => {
    const co = await company("Dup");
    const me = await admin([co]);
    const { enquiry } = await enquiryIn(co, { products: [{ product: "Chino", quantity: 400 }] });
    const context = { type: "ENQUIRY_STYLE", primaryId: String(enquiry._id), externalKey: "Chino" };
    /* No `label`: an enquiry costing takes its display details from the
       enquiry itself, and the server refuses a client-supplied one. The
       picker sends the context and nothing else. */

    const made = await create(me, co, { context });
    expect(made.status).toBe(201);

    const r = await look(me, co);
    const row = r.body.products.find((p) => p.product === "Chino");
    expect(row.existingCosting).toMatchObject({ id: made.body.costing.id });
  });
});

describe("starting a second costing for the same enquiry product", () => {
  test("hands back the existing one instead of creating a twin", async () => {
    /* Two live costings for one enquiry product is not a harmless duplicate:
       they diverge, both get quoted, and nobody can say afterwards which one
       Sales used. Distinct from the idempotency claim, which catches a RETRY
       of one action — this is a second, deliberate one. */
    const co = await company("Twin");
    const me = await admin([co]);
    const account = await Account.create({
      companyName: "Twin Buyer", companyId: co._id, isActive: true,
      companyOwnership: { source: "MEMBERSHIP_RECORD", resolvedAt: new Date(), proven: true },
    });
    const e = await Enquiry.create({
      enquiryId: `ENQ-T${++seq}`, journeyId: (await journeyIn(co))._id,
      accountId: account._id, companyId: co._id,
      title: "Twins", isActive: true, products: [{ product: "Gilet", quantity: 250 }],
    });
    const context = { type: "ENQUIRY_STYLE", primaryId: String(e._id), externalKey: "Gilet" };

    const first = await create(me, co, { context });
    expect(first.status).toBe(201);

    /* A DIFFERENT idempotency key — a genuine second attempt, not a retry. */
    const second = await create(me, co, { context }, newKey());
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("COSTING_ALREADY_EXISTS");
    expect(second.body.error.details.costingId).toBe(first.body.costing.id);
    /* The costing comes back with it, so the screen can route straight there
       rather than making the person go and find it. */
    expect(second.body.costing.id).toBe(first.body.costing.id);

    expect(await Costing.countDocuments({ "context.externalKey": "Gilet" })).toBe(1);
  });

  test("an archived costing does not block a fresh one", async () => {
    /* Re-costing a product whose earlier costing was put away is ordinary
       work; refusing it would leave no way to start again. */
    const co = await company("Rework");
    const me = await admin([co]);
    const account = await Account.create({
      companyName: "Rework Buyer", companyId: co._id, isActive: true,
      companyOwnership: { source: "MEMBERSHIP_RECORD", resolvedAt: new Date(), proven: true },
    });
    const e = await Enquiry.create({
      enquiryId: `ENQ-R${++seq}`, journeyId: (await journeyIn(co))._id,
      accountId: account._id, companyId: co._id,
      title: "Rework", isActive: true, products: [{ product: "Smock", quantity: 100 }],
    });
    const context = { type: "ENQUIRY_STYLE", primaryId: String(e._id), externalKey: "Smock" };

    const first = await create(me, co, { context });
    expect(first.status).toBe(201);
    await Costing.updateOne({ _id: first.body.costing.id }, { $set: { isArchived: true } });

    const again = await create(me, co, { context }, newKey());
    expect(again.status).toBe(201);
    expect(again.body.costing.id).not.toBe(first.body.costing.id);
  });

  test("two different enquiry products are two different costings", async () => {
    /* ── WHAT THIS REPLACES ────────────────────────────────────────────────
       "Ad-hoc costings are never deduplicated against each other", because
       they referenced nothing and so had no "same work" to collide on. There
       are no costings that reference nothing any more. The claim worth
       keeping is the other half of the deduplication rule the test above
       proves: collision is on the enquiry PRODUCT, so two products are never
       folded into one costing however alike they look. */
    const co = await company("TwoProducts");
    const me = await admin([co]);
    const a = await create(me, co, await sourceBackedBody(co), newKey());
    const b = await create(me, co, await sourceBackedBody(co), newKey());
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.body.costing.id).not.toBe(b.body.costing.id);
  });
});

/* ═══ CHUNK 4C · LIST TO DETAIL, ON ONE SESSION ══════════════════════════ */

describe("moving from the list to a costing", () => {
  test("the same session that lists can open, with no second sign-in", async () => {
    /* ── WHAT WAS OBSERVED ────────────────────────────────────────────────
       The list loaded and opening a costing showed "Sign in required". The
       cause was in the browser's shared session-verify cache, not here — see
       components/access/sessionVerify.test.mjs — but the API side of the
       claim is worth pinning too: nothing about the detail route asks for
       more than the list route does. */
    const co = await company("Session");
    const me = await admin([co]);

    const made = await create(me, co);
    expect(made.status).toBe(201);
    const id = made.body.costing.id;

    const list = await call("/", { token: me.token, company: co._id });
    expect(list.status).toBe(200);
    expect(list.body.costings.map((c) => c.id)).toContain(id);

    /* The SAME token and the same company header — exactly what the browser
       carries from one page to the next. */
    const detail = await call(`/${id}`, { token: me.token, company: co._id });
    expect(detail.status).toBe(200);
    expect(detail.body.costing.id).toBe(id);

    const versions = await call(`/${id}/versions`, { token: me.token, company: co._id });
    expect(versions.status).toBe(200);
  });

  test("the two routes are gated on the same capabilities", async () => {
    /* A list that admits somebody the detail refuses is a screen that shows
       rows nobody can open. Proved by exercising the narrowest grant that
       reaches the list. */
    const co = await company("SameGate");
    const me = await admin([co]);
    const made = await create(me, co);

    const reader = await salesReader([co]);
    const list = await call("/", { token: reader.token, company: co._id });
    const detail = await call(`/${made.body.costing.id}`, { token: reader.token, company: co._id });

    /* Sales sees no unapproved costing in either place — and the same answer
       in both, so neither route leaks the existence of a draft. */
    expect(list.status).toBe(200);
    expect(list.body.costings).toHaveLength(0);
    expect(detail.status).toBe(404);
  });

  test("somebody with no costing grant gets no list and no detail", async () => {
    const co = await company("NoGrant");
    const me = await admin([co]);
    const made = await create(me, co);
    const none = await nobody([co]);

    expect((await call("/", { token: none.token, company: co._id })).status).toBe(403);
    expect((await call(`/${made.body.costing.id}`, { token: none.token, company: co._id })).status).toBe(403);
  });

  test("the access probe answers the Apps tile without needing a company", async () => {
    /* The switcher asks this on pages that have nothing to do with costing.
       Requiring the company context would answer COMPANY_SELECTION_REQUIRED
       for anybody in two companies, so the tile would vanish for exactly the
       people most likely to need it — for a reason that has nothing to do
       with their permissions. */
    const a = await company("ProbeA");
    const b = await company("ProbeB");
    const both = await admin([a, b]);

    const probe = await call("/access", { token: both.token });
    expect(probe.status).toBe(200);
    expect(probe.body.hasAccess).toBe(true);
    expect(probe.body.capabilities.length).toBeGreaterThan(0);

    /* And it grants nothing: no costing data of any kind comes back. */
    expect(probe.body.costings).toBeUndefined();
    expect(probe.body.costing).toBeUndefined();

    const none = await nobody([a]);
    const denied = await call("/access", { token: none.token });
    expect(denied.status).toBe(200);
    expect(denied.body.hasAccess).toBe(false);
    expect(denied.body.capabilities).toEqual([]);
  });
});
