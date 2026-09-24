// test/industrial-engineering/ie-costing-quotation-chain.route.test.js
//
// THE WHOLE CHAIN, ONCE THROUGH AND THEN AGAIN.
//
// R&D revision 1 → IE version 1 → Costing version 1 → a quotation decision
// taken against it. Then the garment changes, and every one of those four
// artefacts has to behave: the old ones stay exactly as they are, the new ones
// are produced only by somebody deciding to produce them, and nothing carries
// forward on its own.
//
// ── WHAT THIS FILE IS FOR ───────────────────────────────────────────────────
// The rebase work proved the IE half: a successor cycle exists, and the stale
// binding clears when a successor version is approved. What it did NOT prove
// is the arm past Costing — that a quotation priced from version 1 does not
// silently become a quotation for version 2, that sending it is refused while
// its source has moved, and that a successor decision costs an explicit
// re-approval.
//
// ── AND IT ADDS NO RULE ─────────────────────────────────────────────────────
// Every refusal asserted here already existed: `verifyBeforeSend` →
// `approvedOutput.supersessionFor` is the governed rule for a moved costing
// source, and the quotation save has always re-stamped provenance from the
// approved version rather than from the body. Nothing here is a second
// spelling of either. This file is a test.
"use strict";
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

jest.mock("../../Middlewear/SalesAuthMiddlewear", () => {
  const mw = (req, res, next) => {
    if (!global.__SALES_ACTOR__) return res.status(401).json({ success: false });
    req.user = global.__SALES_ACTOR__;
    next();
  };
  mw.withRoles = () => mw;
  mw.RND_ROLES = [];
  return mw;
});

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const Employee = require("../../models/Employee");
const DeptUser = require("../../models/Access/DeptUser");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");
const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
const Costing = require("../../models/CMS_Models/Costing/Costing");
const CostingVersion = require("../../models/CMS_Models/Costing/CostingVersion");
const IeStyleFile = require("../../models/CMS_Models/IndustrialEngineering/IeStyleFile");
const IeBulletinVersion = require("../../models/CMS_Models/IndustrialEngineering/IeBulletinVersion");
const Operation = require("../../models/CMS_Models/Inventory/Configurations/Operation");

/* Lane B's fixtures, USED and not touched: they are the only place that knows
   what a real costing needs behind it. */
const {
  seedSourceBacked, configureProduction, approveFinancingPolicy,
  EVERY_FAMILY, prepareForCosting, confirmCommercialLine,
} = require("../costing/helpers/sourceBacked");
const authority = require("../costing/helpers/authorityChain");
const { fingerprintId, fingerprintPart } = require("../costing/helpers/storedCosting");

const bind = require("../../services/centralCosting/approvedTechnicalSource.service");

jest.setTimeout(300000);

let rs, server, costingBase, salesBase, rndBase, seq = 0;

beforeAll(async () => {
  await mongoose.disconnect();
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(rs.getUri(), { dbName: "ie_costing_quotation_chain" });

  const app = express();
  app.use(express.json());
  app.use("/api/costings", require("../../routes/CMS_Routes/Costing/costings"));
  app.use("/api/sales", (req, _res, next) => { req.user = app.locals.actor; next(); },
    require("../../routes/CMS_Routes/Sales/quotationRoutes"));
  app.use("/api/cms/crm/sample-styles", require("../../routes/CMS_Routes/Sales/sampleStyles"));
  await new Promise((r) => { server = app.listen(0, r); });
  const port = server.address().port;
  costingBase = `http://127.0.0.1:${port}/api/costings`;
  salesBase = `http://127.0.0.1:${port}/api/sales`;
  rndBase = `http://127.0.0.1:${port}/api/cms/crm/sample-styles`;
  global.__app = app;
  await IeStyleFile.syncIndexes();
});

afterAll(async () => {
  await authority.stop();
  if (server) await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  if (rs) await rs.stop();
});

const hit = (baseUrl, path, { method = "GET", body, token, idempotencyKey, company } = {}) =>
  fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      ...(company ? { "X-Costing-Company": String(company) } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

const costing = (p, o) => hit(costingBase, p, o);
const sales = (p, o) => hit(salesBase, p, o);
const rnd = (p, o) => hit(rndBase, p, o);

const newKey = () => `chain-${++seq}-${Math.random().toString(36).slice(2)}`;

async function actor(companies = [], { role = "employee" } = {}) {
  const n = ++seq;
  const email = `chain-${n}@test.example`;
  const emp = await Employee.create({
    firstName: "C", lastName: `H${n}`, email, biometricId: `CH${n}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  await DeptUser.create({
    name: "Admin", email, passwordHash: "x", isAdmin: true, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  for (const co of companies) {
    await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "C" });
  }
  return {
    id: String(emp._id), email,
    user: { id: String(emp._id), email, name: `Chain ${n}`, role, employeeId: emp.biometricId },
    token: jwt.sign(
      { id: String(emp._id), email, name: `Chain ${n}`, role, employeeId: emp.biometricId },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "60m" },
    ),
  };
}

const POLICY = {
  /* The policy route is optimistically concurrent: a change states the version
     it was based on, and 0 is "there is none yet". Every other Costing suite
     sends it; omitting it here made the PUT a silent 400. */
  revision: 0,
  baseCurrency: "INR", roundingMode: "HALF_UP", sellingPriceIncrementMinor: 100,
};

const SCENARIOS = [{ key: "q500", label: "500 pcs", quantity: "500", isPrimary: true }];

/* ── WHAT EACH ARTEFACT SAYS, AS ONE STRING ────────────────────────────────
   Immutability here means "this document did not change", so the comparison is
   over the whole stored document rather than a field somebody chose. */
/* ── KEY ORDER IS NOT CONTENT ──────────────────────────────────────────
   This was `JSON.stringify(doc)`, which compares the order Mongoose happened
   to serialise subdocument fields in as well as their values. A save that
   rewrites a document without changing any value can reorder them, and the
   comparison then reports a change that did not happen.

   So keys are sorted at every depth before stringifying. The claim is exactly
   as strong: every value, at every path, still has to be identical — only the
   order they are printed in stops mattering. */
const canonical = (v) => {
  if (Array.isArray(v)) return v.map(canonical);
  /* Only PLAIN objects are reordered. An ObjectId, a Date or a Buffer knows how
     to serialise itself, and recursing into one rebuilds it as a bag of its
     internals — which is a different value, not a reordered one. */
  if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
    return Object.keys(v).sort().reduce((out, k) => {
      out[k] = canonical(v[k]);
      return out;
    }, {});
  }
  return v;
};
const frozen = (doc) => JSON.stringify(canonical(doc));

const rndRevisionOf = async (styleId, revision) => {
  const style = await SampleStyle.findById(styleId).lean();
  return (style.techSheet.technicalRevisions || []).find((r) => r.revision === revision) || null;
};

/**
 * Everything up to and including a quotation decision against costing v1.
 *
 * Built through the doors each department actually uses: Lane B's fixture for
 * the sources and the costing, the IE routes for the confirmation, and the
 * quotation save for the commercial decision.
 */
async function chain() {
  const co = await Acc_Company.create({
    companyName: `Chain ${++seq}`, booksFromDate: new Date("2026-04-01"),
  });
  const me = await actor([co]);
  global.__app.locals.actor = me.user;

  /* ── CHECKED, NOT ASSUMED ────────────────────────────────────────────
     This discarded the status. A rejected policy PUT left the company with no
     policy document, `configured` false, and every costing below refused with
     "Company costing policy is not configured" — a setup failure wearing the
     costume of a product one. A fixture's own calls are asserted. */
  const policySet = await costing("/policy/current", {
    method: "PUT", token: me.token, company: co._id, body: POLICY,
  });
  if (policySet.status !== 200) {
    throw new Error(`chain: the costing policy was not accepted (${policySet.status}) `
      + `${JSON.stringify(policySet.body?.error || policySet.body)}`);
  }
  await approveFinancingPolicy(co._id);

  /* 1 · R&D revision 1, and 4 · the Store quotation that rates it — both from
     the fixture, which is the only place that knows the whole set. */
  const seeded = await seedSourceBacked(co._id, {
    brief: { quantities: SCENARIOS, quantityUom: "Pieces" }, ...EVERY_FAMILY,
  });
  await configureProduction(co._id);

  /* ── THE LIVE R&D DRAFT, AND MERCHANDISING'S PICK ─────────────────────
     Only this suite needs them, because only this suite drives R&D's OWN
     mounted lifecycle to author revision 2, and that lifecycle gates on two
     records the Costing builder does not write:

       · `techSheet.technical.materials` / `.operations` — the live draft.
         The approved revision's snapshot has both, but the draft it was
         submitted from was never written, so R&D's completeness check reports
         "R&D still needs the operations this style is made through". The route
         IGNORES an `operations` key in its body (a route is not R&D's to write
         any more), so it cannot be supplied through the save either.

       · `materials.rawItems` — Merchandising's selection as
         `approvedMaterialShortlist` reads it. That service looks at the
         finished good, then an approved Development BOM, then this legacy
         pick; it does not look at `bomApproval`, which is the form Central
         Costing's own binding uses. Both are real records of the same
         decision, and this states it in the form R&D's gate reads.

     Written to MATCH the approved revision, never to diverge from it: a draft
     that disagreed with what IE confirmed would make revision 2 a change to
     something nobody approved. */
  {
    const approved = (seeded.style.techSheet?.technicalRevisions || [])
      .find((r) => r.outcome === "approved");
    if (!approved) throw new Error("chain: the builder seeded no approved technical revision");
    await SampleStyle.updateOne({ _id: seeded.style._id }, {
      $set: {
        "techSheet.technical.materials": approved.snapshot.materials || [],
        /* Each row names the REGISTERED Operation master by id, which the
           schema requires and which is also where the salary basis lives —
           resolved by the code the revision carries, never minted here. */
        "techSheet.technical.operations": await Promise.all(
          (approved.snapshot.operations || []).map(async (o) => {
            /* The Operation master has no `companyId` — it is a global
               register, and a scoped query matches nothing. Code is the
               identity, which is also how `costOperations` finds the salary
               basis behind a bulletin row. */
            const master = await Operation.findOne({
              operationCode: o.operationCode,
            }).lean();
            if (!master) {
              throw new Error(`chain: no Operation master is registered for ${o.operationCode}`);
            }
            return {
              operationId: master._id,
              operationCode: o.operationCode,
              name: o.name,
              machineType: o.machineType,
              minutes: o.minutes,
              seconds: o.seconds,
            };
          }),
        ),
        "materials.rawItems": (approved.snapshot.materials || []).map((m) => ({
          rawItemId: m.rawItemId,
          rawItemName: m.rawItemName,
          quantity: m.consumptionPerPiece,
          unit: m.unit,
        })),
      },
    });
  }

  /* 2 · IE version 1, through the IE routes, maker and checker. */
  expect(seeded.ieConfirmation).toBeTruthy();

  /* 3 · Costing version 1, prepared the way Sales prepares one. */
  const made = await costing("/", {
    method: "POST", token: me.token, company: co._id, idempotencyKey: newKey(),
    body: { context: seeded.context },
  });
  expect(made.status).toBe(201);
  const costingId = made.body.costing.id;

  const calc = await prepareForCosting(costingId);
  expect(calc.status).toBe(201);
  const versionOneId = newestOf(calc).id;

  const submitted = await costing(`/${costingId}/versions/${versionOneId}/submit`, {
    method: "POST", token: me.token, company: co._id, idempotencyKey: newKey(), body: {},
  });
  expect(submitted.status).toBe(200);
  const approved = await costing(`/${costingId}/versions/${versionOneId}/approve`, {
    method: "POST", token: me.token, company: co._id, idempotencyKey: newKey(), body: { note: "Approved." },
  });
  expect(approved.status).toBe(200);

  await confirmCommercialLine(co._id, {
    enquiryId: seeded.context.primaryId, styleId: seeded.style._id, quantity: 500,
  });

  /* 5 · and the commercial decision taken against it. The browser says which
     style and which approved price; the server writes the provenance. */
  const request = await CustomerRequest.create({
    requestId: `REQ-CHAIN-${++seq}`, customerInfo: { name: "Acme" },
  });
  const quoted = await sales(`/requests/${request._id}/quotation`, {
    method: "POST", token: me.token,
    body: {
      currency: "INR", status: "draft",
      validUntil: new Date(Date.now() + 30 * 864e5).toISOString(),
      items: [{
        itemName: seeded.product, quantity: 500, unitPrice: 0,
        costingIntent: { sampleStyleId: String(seeded.style._id), tier: "floor" },
      }],
    },
  });
  expect(quoted.status).toBe(200);

  const styleId = String(seeded.style._id);
  const ie = seeded.ieConfirmation;

  return {
    co, me, seeded, styleId, costingId, versionOneId, request,
    fileId: ie.fileId, ieVersionOneId: ie.versionId, maker: ie.maker, checker: ie.checker,
    /* 6 · the four immutable copies, taken before anything moves. */
    before: {
      rndRevision: frozen(await rndRevisionOf(styleId, 1)),
      ieVersion: frozen(await IeBulletinVersion.findById(ie.versionId).lean()),
      costingVersion: frozen(await CostingVersion.findById(versionOneId).lean()),
      quotation: frozen((await CustomerRequest.findById(request._id).lean()).quotations[0]),
    },
  };
}

/* A fixture step that fails must say WHY, or a 400 from a real route becomes
   an unexplained number in a test report. */
const step = (res, what) => {
  if (res.status !== 200) {
    throw new Error(`chain: ${what} was refused (${res.status}) `
      + `${JSON.stringify(res.body?.error || res.body)}`);
  }
  return res;
};

/* ── THE NEWEST VERSION, CHOSEN BY ITS NUMBER ──────────────────────────────
   Two tests read `versions[versions.length - 1]`, but the prepare response is
   sorted by version number DESCENDING, so that is the OLDEST — here the empty
   draft that creating a costing seeds. Submitting and approving THAT is what
   the 409 was. The number is the order, so it is what selects. */
const newestOf = (res) => (res.body.versions || [])
  .reduce((best, v) => (v.versionNumber > (best?.versionNumber ?? -1) ? v : best), null);

/** R&D revision 2, through R&D's own mounted lifecycle. */
async function publishRevisionTwo(w, { consumption }) {
  global.__SALES_ACTOR__ = { ...w.me.user, role: "sales" };
  /* ── BASED ON WHAT IE CONFIRMED, NOT ON A LIVE DRAFT FIELD ───────────
       This read `techSheet.technical.materials`, which the builder does not
       write — it records the rows inside the APPROVED REVISION's snapshot,
       which is also the only version anybody confirmed. Revision 2 is "the
       fabric IE approved, at a different weight", so it is based on that. */
  const style = await SampleStyle.findById(w.styleId).lean();
  const approvedRevision = (style.techSheet?.technicalRevisions || [])
    .filter((r) => r.outcome === "approved")
    .reduce((best, r) => (r.revision > (best?.revision ?? -1) ? r : best), null);
  const material = approvedRevision?.snapshot?.materials?.[0];
  if (!material) {
    throw new Error("chain: the style has no approved technical revision carrying a material to revise");
  }

  const reopened = await rnd(`/${w.styleId}/tech-sheet`, {
    method: "POST", token: w.me.token, body: { action: "revise", note: "Buyer changed the fabric weight." },
  });
  step(reopened, "reopening the tech sheet for revision 2");

  const saved = await rnd(`/${w.styleId}/technical`, {
    method: "PUT", token: w.me.token,
    body: {
      materials: [{
        rawItemId: String(material.rawItemId),
        rawItemName: material.rawItemName,
        consumptionPerPiece: consumption,
        allowancePercent: material.allowancePercent,
        unit: material.unit,
        specification: material.specification,
      }],
      requirements: [],
    },
  });
  step(saved, "the revision-2 technical save");

  const submitted = await rnd(`/${w.styleId}/tech-sheet`, {
    method: "POST", token: w.me.token,
    body: { action: "submit", file: { name: "rev-2.pdf", url: "https://example.test/rev-2.pdf" } },
  });
  step(submitted, "the revision-2 submit");

  const approvedRnd = await rnd(`/${w.styleId}/tech-sheet`, {
    method: "POST", token: w.me.token, body: { action: "approve", note: "Accepted." },
  });
  step(approvedRnd, "the revision-2 R&D approval");
  return approvedRnd;
}

/** IE's successor cycle, through the IE routes: rebase, review, submit, approve. */
async function ieVersionTwo(w) {
  const t = { token: w.maker.token, company: w.co._id };
  const file = (await authority.call(`/styles/${w.styleId}/engineering-file`, t)).body.file;

  const moved = await authority.call(`/engineering-files/${w.fileId}/rebase-source`, {
    method: "POST", ...t, body: { expectedRevision: file.revision, reason: "R&D revised the consumption." },
  });
  expect(moved.status).toBe(200);

  const reviewed = await authority.call(`/engineering-files/${w.fileId}/rebase-review`, {
    method: "POST", ...t,
    body: {
      expectedRevision: moved.body.file.revision,
      rowIds: moved.body.reviewRequiredRowIds,
      acknowledgeSource: true,
    },
  });
  expect(reviewed.status).toBe(200);

  const submitted = await authority.call(`/engineering-files/${w.fileId}/bulletin-versions`, {
    method: "POST", ...t, body: { expectedRevision: reviewed.body.file.revision },
  });
  expect(submitted.status).toBe(201);

  const approvedVersion = await authority.call(`/bulletin-versions/${submitted.body.version.bulletinVersionId}/approve`, {
    method: "POST", token: w.checker.token, company: w.co._id,
    body: { expectedRevision: submitted.body.version.revision },
  });
  expect(approvedVersion.status).toBe(200);
  return { moved, reviewed, versionId: submitted.body.version.bulletinVersionId };
}

const ctxOf = (w) => ({ companyId: w.co._id, actorId: new mongoose.Types.ObjectId() });

const quotationOf = async (requestId) =>
  (await CustomerRequest.findById(requestId).lean()).quotations[0];

const sendQuotation = (w) =>
  sales(`/requests/${w.request._id}/quotation/send`, {
    method: "POST", token: w.me.token, body: {},
  });

const requote = (w) =>
  sales(`/requests/${w.request._id}/quotation`, {
    method: "POST", token: w.me.token,
    body: {
      currency: "INR", status: "draft",
      validUntil: new Date(Date.now() + 30 * 864e5).toISOString(),
      items: [{
        itemName: w.seeded.product, quantity: 500, unitPrice: 0,
        costingIntent: { sampleStyleId: w.styleId, tier: "floor" },
      }],
    },
  });

/* ═══ THE JOURNEY ══════════════════════════════════════════════════════════ */

describe("R&D → IE → Costing → quotation, twice", () => {
  test("the chain is built, and every artefact names the one before it", async () => {
    const w = await chain();

    const bound = await bind.bindFor(ctxOf(w), { styleId: w.styleId });
    expect(bound.state).toBe("BOUND");

    const v1 = await CostingVersion.findById(w.versionOneId).lean();
    /* Costing version 1 was calculated from the IE version that confirmed R&D
       revision 1 — the provenance says so, rather than a reader inferring it
       from dates. */
    /* ── READ WHERE THE FREEZE ACTUALLY PUTS IT ───────────────────────
       This guessed at `approvedSource.technical.bulletinVersionId` on the
       stored document, which is the shape of the LIVE binding, not of a frozen
       version. A version records what it was calculated from as fingerprint
       parts under `provenance`, and `ie:version` carries
       `<bulletinVersionId>:<versionNo>` — which is what "have the inputs moved
       since?" is answered from, so it is also the right thing to assert. */
    expect(fingerprintId(v1, "ie:version")).toBe(String(w.ieVersionOneId));
    /* The whole token, against the version's OWN number rather than an
       assumed one — the part is an identity pair and both halves are frozen. */
    const ieV1 = await IeBulletinVersion.findById(w.ieVersionOneId).lean();
    expect(fingerprintPart(v1, "ie:version").token)
      .toBe(`${String(w.ieVersionOneId)}:${ieV1.versionNo}`);

    const quotation = await quotationOf(w.request._id);
    const line = quotation.items[0];
    expect(line.costingSource.source).toBe("APPROVED_COSTING");
    expect(String(line.costingSource.costingVersionId)).toBe(String(w.versionOneId));
    expect(line.unitPrice).toBeGreaterThan(0);
  });

  test("a newer R&D revision makes the binding stale, and no costing may be recalculated", async () => {
    const w = await chain();
    await publishRevisionTwo(w, { consumption: 2.5 });

    /* 8 · the confirmation stands as a record and is not the current basis. */
    const stale = await bind.bindFor(ctxOf(w), { styleId: w.styleId });
    expect(stale.state).toBe("IE_TECHNICAL_APPROVAL_STALE");
    expect(stale.owner.departmentSlug).toBe("ie");

    /* 9 · and preparing again produces nothing: there is no second costing
       version until IE has confirmed the revision it would be built from. */
    const before = await CostingVersion.countDocuments({ costingId: w.costingId });
    const refused = await prepareForCosting(w.costingId);
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(await CostingVersion.countDocuments({ costingId: w.costingId })).toBe(before);
  });

  test("the successor chain is built only by deciding to build it", async () => {
    const w = await chain();
    await publishRevisionTwo(w, { consumption: 2.5 });
    const { versionId: ieVersionTwoId } = await ieVersionTwo(w);

    /* ── COUNTED AS A CHANGE, NOT AS A TOTAL ─────────────────────────
       This asserted a total of 2 and forgot the empty DRAFT that CREATING a
       costing seeds (`costingCreation.service.js`: versionNumber 1, origin
       MANUAL, `calculationSchemaVersion: 0`, no calculation at all). So the
       real world is three documents, and the claim of this test is not how
       many there are — it is that deciding to build a successor adds EXACTLY
       ONE, and that the one it adds is built from IE version 2. */
    const before = await CostingVersion.countDocuments({ costingId: w.costingId });

    /* 11 · costing version 2, prepared from the newly confirmed source. */
    const calc = await prepareForCosting(w.costingId);
    expect(calc.status).toBe(201);
    const versions = await CostingVersion.find({ costingId: w.costingId }).sort({ versionNumber: 1 }).lean();
    expect(versions).toHaveLength(before + 1);

    /* The seeded draft is still the empty one nobody calculated — a successor
       must not be produced by back-filling it. */
    const seededDraft = versions[0];
    expect(seededDraft.provenance.origin).toBe("MANUAL");
    expect(seededDraft.calculationSchemaVersion).toBe(0);
    expect(fingerprintPart(seededDraft, "ie:version")).toBeNull();

    /* Exactly one version was built from IE version 2, and it is the newest. */
    const fromIeTwo = versions.filter((v) => fingerprintId(v, "ie:version") === String(ieVersionTwoId));
    expect(fromIeTwo).toHaveLength(1);
    const two = fromIeTwo[0];
    expect(String(two._id)).toBe(String(versions[versions.length - 1]._id));

    /* And the earlier estimate still names the version it was built from —
       a successor does not re-explain its predecessor. */
    const one = versions.find((v) => String(v._id) === String(w.versionOneId));
    expect(fingerprintId(one, "ie:version")).toBe(String(w.ieVersionOneId));

    /* 12 · and its frozen provenance names the new sources and the new fact. */
    expect(fingerprintPart(two, "ie:technicalRevision").token).toMatch(/^2:/);
    expect(two.provenance.sourceFingerprint).toBeTruthy();
    expect(two.provenance.sourceFingerprint).not.toBe(one.provenance.sourceFingerprint);

    /* The changed consumption reached the costing, not just the record. */
    const ieTwo = await IeBulletinVersion.findById(ieVersionTwoId).lean();
    expect(ieTwo.technicalSource.snapshot.materials[0].consumptionPerPiece).toBe(2.5);
    const boundNow = await bind.bindFor(ctxOf(w), { styleId: w.styleId });
    expect(boundNow.state).toBe("BOUND");
    expect(boundNow.technical.materials[0].consumptionPerPiece).toBe(2.5);
  });

  test("every version-1 artefact is byte-identical afterwards", async () => {
    const w = await chain();
    await publishRevisionTwo(w, { consumption: 2.5 });
    await ieVersionTwo(w);
    expect((await prepareForCosting(w.costingId)).status).toBe(201);

    /* 13 · the four copies taken before anything moved, compared whole. */
    expect(frozen(await rndRevisionOf(w.styleId, 1))).toBe(w.before.rndRevision);
    expect(frozen(await CostingVersion.findById(w.versionOneId).lean())).toBe(w.before.costingVersion);
    expect(frozen((await CustomerRequest.findById(w.request._id).lean()).quotations[0]))
      .toBe(w.before.quotation);

    /* The IE version keeps every field except the one the successor's approval
       is ENTITLED to move: its state, and the number that superseded it. */
    const ieNow = await IeBulletinVersion.findById(w.ieVersionOneId).lean();
    const ieBefore = JSON.parse(w.before.ieVersion);
    expect(ieNow.state).toBe("SUPERSEDED");
    /* Compared through the SAME serialisation on both sides. `ieBefore` has
       already been through a JSON round trip, so its dates are strings and its
       ids are hex; putting the live document through `frozen` too is what makes
       the two comparable, and every value still has to match. */
    for (const field of ["technicalSource", "rows", "totals", "approvedBy"]) {
      expect(frozen(ieNow[field])).toBe(frozen(ieBefore[field]));
    }
  });
});

/* ═══ THE QUOTATION ARM ════════════════════════════════════════════════════ */

describe("the commercial decision does not follow the costing", () => {
  test("the standing decision still names costing version 1, and is readable", async () => {
    const w = await chain();
    await publishRevisionTwo(w, { consumption: 2.5 });
    await ieVersionTwo(w);
    expect((await prepareForCosting(w.costingId)).status).toBe(201);

    /* 14 · nothing re-priced it, re-sourced it or re-approved it. */
    const quotation = await quotationOf(w.request._id);
    const line = quotation.items[0];
    expect(String(line.costingSource.costingVersionId)).toBe(String(w.versionOneId));
    expect(frozen(quotation)).toBe(w.before.quotation);
  });

  test("sending it is refused by the governed rule, once its source is superseded", async () => {
    const w = await chain();
    await publishRevisionTwo(w, { consumption: 2.5 });
    await ieVersionTwo(w);

    const calc = await prepareForCosting(w.costingId);
    expect(calc.status).toBe(201);
    const versionTwoId = newestOf(calc).id;

    /* ── A DRAFT COSTING SUPERSEDES NOTHING, ASSERTED WITHOUT SENDING ──
       This proved it by SENDING and expecting 200. That consumed the one send
       this quotation has: the second send was then refused for being already
       sent, not for its source being superseded, and the test passed its own
       precondition while never reaching its subject.

       The claim is about the quotation's STATE, so the state is what is read.
       Costing version 2 exists and is a draft, and the standing decision still
       names version 1 — which is exactly "nobody has superseded anything". */
    const draftStage = await CostingVersion.findById(versionTwoId).lean();
    expect(draftStage.status).toBe("DRAFT");
    const standing = await quotationOf(w.request._id);
    expect(standing.status).toBe("draft");
    expect(String(standing.items[0].costingSource.costingVersionId))
      .toBe(String(w.versionOneId));

    /* Both halves checked: an unasserted submit made a failed approval look
       like an approval rule when it was a submit that never happened. */
    step(await costing(`/${w.costingId}/versions/${versionTwoId}/submit`, {
      method: "POST", token: w.me.token, company: w.co._id, idempotencyKey: newKey(), body: {},
    }), "submitting costing version 2");
    const approvedTwo = await costing(`/${w.costingId}/versions/${versionTwoId}/approve`, {
      method: "POST", token: w.me.token, company: w.co._id, idempotencyKey: newKey(), body: { note: "Approved." },
    });
    step(approvedTwo, "approving costing version 2");

    /* 15 · and now the existing governed state refuses the send. */
    const refused = await sendQuotation(w);
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.body.code).toBe("QUOTATION_SOURCE_SUPERSEDED");
  });

  test("an explicit re-quote is what creates the successor decision", async () => {
    const w = await chain();
    await publishRevisionTwo(w, { consumption: 2.5 });
    await ieVersionTwo(w);
    const calc = await prepareForCosting(w.costingId);
    const versionTwoId = newestOf(calc).id;
    await costing(`/${w.costingId}/versions/${versionTwoId}/submit`, {
      method: "POST", token: w.me.token, company: w.co._id, idempotencyKey: newKey(), body: {},
    });
    await costing(`/${w.costingId}/versions/${versionTwoId}/approve`, {
      method: "POST", token: w.me.token, company: w.co._id, idempotencyKey: newKey(), body: { note: "Approved." },
    });

    const beforeRequote = await quotationOf(w.request._id);
    expect(String(beforeRequote.items[0].costingSource.costingVersionId)).toBe(String(w.versionOneId));

    /* 16 · somebody asks for the approved price again, and the server stamps
       the version that is approved NOW. */
    const again = await requote(w);
    expect(again.status).toBe(200);

    const after = await quotationOf(w.request._id);
    expect(String(after.items[0].costingSource.costingVersionId)).toBe(String(versionTwoId));
    /* The price is the new version's, and it was never sent from the body. */
    const v2 = await CostingVersion.findById(versionTwoId).lean();
    const scenario = v2.scenarios.find((s) => Number(s.quantity) === 500) || v2.scenarios[0];
    expect(Math.round(after.items[0].unitPrice * 100)).toBe(scenario.floor.floorPriceMinor);
  });
});

/* ═══ REPEATING THE MOVES ══════════════════════════════════════════════════ */

describe("the transitions are safe to repeat", () => {
  test("a second rebase, review and prepare add nothing", async () => {
    const w = await chain();
    await publishRevisionTwo(w, { consumption: 2.5 });
    const { reviewed } = await ieVersionTwo(w);
    expect((await prepareForCosting(w.costingId)).status).toBe(201);

    const versionsAfterFirst = await CostingVersion.countDocuments({ costingId: w.costingId });
    const ieVersionsAfterFirst = await IeBulletinVersion.countDocuments({ ieStyleFileId: w.fileId });

    /* 17 · the same three commands again. */
    const file = (await authority.call(`/styles/${w.styleId}/engineering-file`, {
      token: w.maker.token, company: w.co._id,
    })).body.file;
    const rebaseAgain = await authority.call(`/engineering-files/${w.fileId}/rebase-source`, {
      method: "POST", token: w.maker.token, company: w.co._id,
      body: { expectedRevision: file.revision },
    });
    expect(rebaseAgain.status).toBeGreaterThanOrEqual(400);
    expect(rebaseAgain.body.error.code).toBe("IE_SOURCE_REBASE_NOT_REQUIRED");

    const reviewAgain = await authority.call(`/engineering-files/${w.fileId}/rebase-review`, {
      method: "POST", token: w.maker.token, company: w.co._id,
      body: { expectedRevision: file.revision, acknowledgeSource: true },
    });
    /* Acknowledging twice is not an error and mints nothing. */
    expect([200, 409]).toContain(reviewAgain.status);

    const prepareAgain = await prepareForCosting(w.costingId);
    expect([200, 201, 409, 422]).toContain(prepareAgain.status);

    expect(await CostingVersion.countDocuments({ costingId: w.costingId })).toBe(versionsAfterFirst);
    expect(await IeBulletinVersion.countDocuments({ ieStyleFileId: w.fileId })).toBe(ieVersionsAfterFirst);
    expect(reviewed.body.acknowledged).toBe(true);
  });
});
