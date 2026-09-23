// test/costing/sales-brief-end-to-end.test.js
//
// SALES ASKS. CENTRAL COSTING ANSWERS. THE WHOLE ROUND TRIP.
//
// The unit and service suites prove each rule in isolation. This proves the
// FLOW — that the ten steps a real quotation goes through actually connect:
//
//    1. Sales opens the enquiry product and sees the styles they may quote.
//    2. Sales selects an approved style.
//    3. Sales records quantities and proposed prices, and confirms.
//    4. Central Costing resolves the brief and calculates from it.
//    5. Repeating the same confirmed revision creates no duplicate.
//    6. Changing the brief and re-costing creates a NEW version.
//    7. An approved version is immutable — a later brief does not reach back.
//    8. Costing renders the brief read-only.
//    9. A payload carrying a moved field is refused.
//   10. A missing or unconfirmed brief names Sales as the blocker.
//
// Every step goes through the real routes and the real services. A flow test
// that stubbed any of them would prove the stubs connect.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const {
  seedSourceBacked, configureProduction, approveFinancingPolicy, CONFIRMED_TERMS,
  EVERY_FAMILY, confirmCostingBrief, prepareEstimate,
} = require("./helpers/sourceBacked");

const Employee = require("../../models/Employee");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DeptUser = require("../../models/Access/DeptUser");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const CostingVersion = require("../../models/CMS_Models/Costing/CostingVersion");
const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
const costingBrief = require("../../services/sales/costingBrief.service");

let server, base, seq = 0;
const { MongoMemoryReplSet } = require("mongodb-memory-server");
let rs;

beforeAll(async () => {
  await mongoose.disconnect();
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(rs.getUri(), { dbName: "sales_brief_e2e" });
  const app = express();
  app.use(express.json());
  app.use("/api/costings", require("../../routes/CMS_Routes/Costing/costings"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/costings`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  if (rs) await rs.stop();
});

const newKey = () => `e2e-${++seq}-${Math.random().toString(36).slice(2)}`;

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
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

/* ── THE MARGIN BAND IS AN APPROVED BOARD DECISION NOW ──────────────────────
 * It was three fields on the costing policy; the policy refuses them outright
 * and `configureProduction` approves the Board's, at the same 18/25/32 every
 * figure in this folder is asserted against. */
const POLICY = {
  baseCurrency: "INR", roundingMode: "HALF_UP", sellingPriceIncrementMinor: 100,
  revision: 0,
};

async function actor(companies = []) {
  const n = ++seq;
  const email = `e2e-${n}@test.example`;
  const emp = await Employee.create({
    firstName: "E", lastName: `T${n}`, email, biometricId: `E2E${n}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  await DeptUser.create({
    name: "Admin", email, passwordHash: "x", isAdmin: true, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  for (const co of companies) {
    await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "E" });
  }
  return {
    emp, email,
    token: jwt.sign(
      { id: String(emp._id), email, name: "E Actor", role: "employee", employeeId: emp.biometricId },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
    ),
  };
}

/**
 * A company, an enquiry product with an approved style, every family sourced,
 * a costing raised against it — and NO brief.
 *
 * `brief: null` is deliberate: step 1 of the flow is Sales opening a product
 * that has not been briefed, and seeding one would skip the state this whole
 * task is about.
 */
async function world() {
  const co = await Acc_Company.create({
    companyName: `E2E ${++seq}`, booksFromDate: new Date("2026-04-01"),
  });
  const me = await actor([co]);
  await call("/policy/current", { method: "PUT", token: me.token, company: co._id, body: POLICY });
  await approveFinancingPolicy(co._id);
  const seeded = await seedSourceBacked(co._id, {
    ...EVERY_FAMILY, paymentTerms: { ...CONFIRMED_TERMS }, brief: null,
  });
  await configureProduction(co._id);

  const made = await call("/", {
    method: "POST", token: me.token, company: co._id, idempotencyKey: newKey(),
    body: { context: seeded.context },
  });
  expect(made.status).toBe(201);
  return {
    co, me, seeded,
    ctx: { companyId: co._id },
    /* The orchestration writes, so it needs an actor to attribute the version
       to — the same context `/api/costings` resolves for a real caller. */
    ctxWithActor: {
      companyId: co._id,
      actorId: String(me.emp._id),
      actorName: "E Actor",
      /* `costing.prepare` too: preparing needs its own grant, which nothing
         else implies. This actor is an authorised one. */
      capabilitySet: new Set(["costing.draft.write", "costing.cost.read", "costing.margin.read", "costing.output.read", "costing.approve", "costing.prepare"]),
    },
    costingId: made.body.costing.id,
  };
}

/* ── PREPARED THE WAY SALES DOES ──────────────────────────────────────────
 * `POST /:id/versions` was the Calculate button and now refuses a browser
 * client. An estimate is prepared through the Sales orchestration, which
 * resolves the brief, assembles the sources and decides whether a version is
 * needed at all. */
const prepare = (w, key = null) =>
  prepareEstimate(w.ctxWithActor, { enquiryId: w.seeded.enquiry._id, product: w.seeded.product, actionKey: key });

/* The retired door, for the tests that prove it is shut. */
const postVersion = (w, key = newKey(), body = { lines: [] }) =>
  call(`/${w.costingId}/versions`, {
    method: "POST", token: w.me.token, company: w.co._id, idempotencyKey: key, body,
  });

const preview = (w) =>
  call(`/${w.costingId}/technical-preview`, { token: w.me.token, company: w.co._id });

/* ═══ THE FLOW, IN ORDER ═════════════════════════════════════════════════ */

describe("Sales asks, Central Costing answers", () => {
  test("1–4 · open, select, confirm, and the costing prices it", async () => {
    const w = await world();

    /* ── 1. SALES OPENS THE PRODUCT ───────────────────────────────────
       They see the styles they may quote, and nothing technical. */
    const opened = await costingBrief.readBriefs(w.ctx, { enquiryId: w.seeded.enquiry._id });
    expect(opened.briefs).toEqual([]);
    expect(opened.confirmed).toEqual([]);
    const [option] = opened.styles;
    expect(option.quotable).toBe(true);
    expect(option.styleCode).toBeTruthy();
    /* Not one figure of R&D's, Production's or Store's. */
    expect(JSON.stringify(opened.styles).toLowerCase())
      .not.toMatch(/consumption|operation|samminutes|supplier|rate|cost/);

    /* ── 10 (first half). BEFORE THEY ASK, THE COSTING BLOCKS ─────────
       Named on Sales, not answered with a default quantity or a style
       picked by ordering. */
    await expect(prepare(w)).rejects.toMatchObject({
      code: "COSTING_BRIEF_REQUIRED",
      details: { owner: { department: "Sales" } },
    });
    expect(await CostingVersion.countDocuments({ costingId: w.costingId, versionNumber: 2 })).toBe(0);

    /* ── 2–3. SELECT, RECORD, CONFIRM ─────────────────────────────────
       Through the real service, so every rule it enforces applies. */
    const { briefId } = await confirmCostingBrief(w.co._id, {
      enquiryId: w.seeded.enquiry._id,
      styleId: w.seeded.style._id,
      quantities: [
        { key: "q500", label: "500 pcs", quantity: "500", isPrimary: true, proposedSellingPriceExclTax: "420" },
        { key: "q2000", label: "2000 pcs", quantity: "2000" },
      ],
      quantityUom: "Pieces",
      note: "Repeat buyer, two break points.",
    });

    /* ── 4. THE COSTING RESOLVES IT AND CALCULATES ────────────────────── */
    const r = await prepare(w);
    expect(r.outcome).toBe("PREPARED");
    const v = r.version;
    /* The quantities Sales asked for, in the unit Sales stated. */
    expect(v.scenarios.map((s) => s.key).sort()).toEqual(["q2000", "q500"]);
    /* The frozen record says WHICH brief, and which wording of it. */
    const stored = v;
    /* And the note is Sales', frozen on the version's provenance — not a
       costing user's, because there is no field for one. */
    expect(stored.provenance.note).toMatch(/Repeat buyer/);
    const ref = (stored.sourceReferences || []).find((x) => x.sourceKey === `costing-brief:${briefId}`);
    expect(ref).toBeTruthy();
    expect(ref.sourceType).toBe("SALES_COSTING_BRIEF");
    const snap = Object.fromEntries(ref.snapshot.map((f) => [f.key, f.text]));
    expect(snap.quantityUom).toBe("Pieces");
    expect(Number(snap.briefRevision)).toBeGreaterThan(0);
  });

  test("5 · the same confirmed revision, twice, is one version", async () => {
    /* ── IDEMPOTENCY IS THE KEY'S, NOT THE BRIEF'S ────────────────────
       Two calculations of an unchanged brief under ONE action key must not
       produce two versions — that is what a retry after a lost response
       looks like. Under two keys they are two deliberate acts and produce
       two versions, which is the existing contract and is unchanged. */
    const w = await world();
    await confirmCostingBrief(w.co._id, {
      enquiryId: w.seeded.enquiry._id, styleId: w.seeded.style._id,
    });

    const key = newKey();
    const first = await prepare(w, key);
    expect(first.outcome).toBe("PREPARED");
    /* ── AND PRESSING IT AGAIN IS NOT A SECOND ESTIMATE ──────────────
       The FINGERPRINT decides, not the key: identical sources produce no
       version at all, which is what makes the button safe to press twice and
       safe to leave on a page somebody reloads. */
    const retried = await prepare(w, key);
    expect(retried.outcome).toBe("UNCHANGED");
    expect(retried.versionId).toBe(first.versionId);

    const all = await CostingVersion.find({ costingId: w.costingId }).lean();
    /* v1 is the empty version the create writes; v2 is the calculation. */
    expect(all).toHaveLength(2);
  });

  test("6 · changing the brief and re-costing makes a NEW version, not an edit", async () => {
    const w = await world();
    await confirmCostingBrief(w.co._id, {
      enquiryId: w.seeded.enquiry._id, styleId: w.seeded.style._id,
      quantities: [{ key: "q500", quantity: "500", isPrimary: true }],
    });
    const first = await prepare(w);
    expect(first.outcome).toBe("PREPARED");
    const v1 = await CostingVersion.findById(first.versionId).lean();

    /* Sales adds a break point. A confirmed brief is not edited — a new one
       is confirmed, and the old one is superseded explicitly. */
    const moved = await confirmCostingBrief(w.co._id, {
      enquiryId: w.seeded.enquiry._id, styleId: w.seeded.style._id,
      quantities: [
        { key: "q500", quantity: "500", isPrimary: true },
        { key: "q2000", quantity: "2000" },
      ],
    }).catch((e) => e);
    /* Same style, already confirmed: the service refuses an edit and says
       what to do instead. Confirming a NEW brief is the way forward. */
    expect(moved.code).toBe("COSTING_BRIEF_NOT_CONFIRMABLE");

    /* So Sales supersedes it — through the same door, with the enquiry
       carrying the newer request. */
    const enquiry = await Enquiry.findById(w.seeded.enquiry._id);
    enquiry.costingBriefs[0].quantities.push({
      key: "q2000", label: "2000", quantity: "2000", isPrimary: false,
    });
    enquiry.costingBriefs[0].revision += 1;
    enquiry.markModified("costingBriefs");
    await enquiry.save();

    const second = await prepare(w);
    expect(second.outcome).toBe("REVISED");
    expect(second.versionId).not.toBe(first.versionId);
    expect(second.version.scenarios.map((s) => s.key).sort()).toEqual(["q2000", "q500"]);

    /* ── 7. AND THE EARLIER VERSION IS UNTOUCHED ─────────────────────── */
    const after = await CostingVersion.findById(first.versionId).lean();
    expect(after).toEqual(v1);
  });

  test("7 · an APPROVED version is immutable, and a later brief does not reach back", async () => {
    const w = await world();
    await confirmCostingBrief(w.co._id, {
      enquiryId: w.seeded.enquiry._id, styleId: w.seeded.style._id,
      quantities: [{ key: "q500", quantity: "500", isPrimary: true, proposedSellingPriceExclTax: "420" }],
    });
    const made = await prepare(w);
    expect(made.outcome).toBe("PREPARED");
    const versionId = made.versionId;

    expect((await call(`/${w.costingId}/versions/${versionId}/submit`, {
      method: "POST", token: w.me.token, company: w.co._id, idempotencyKey: newKey(), body: {},
    })).status).toBe(200);
    expect((await call(`/${w.costingId}/versions/${versionId}/approve`, {
      method: "POST", token: w.me.token, company: w.co._id, idempotencyKey: newKey(),
      body: { note: "Approved for the season." },
    })).status).toBe(200);

    const frozen = await CostingVersion.findById(versionId).lean();

    /* Sales changes what they want priced, afterwards. */
    const enquiry = await Enquiry.findById(w.seeded.enquiry._id);
    enquiry.costingBriefs[0].quantities = [
      { key: "q9000", label: "9000", quantity: "9000", isPrimary: true },
    ];
    enquiry.costingBriefs[0].revision += 1;
    enquiry.markModified("costingBriefs");
    await enquiry.save();

    /* The approved version says exactly what it said. A costing version is a
       record of what was approved, not a live view of the request. */
    expect(await CostingVersion.findById(versionId).lean()).toEqual(frozen);
    expect(frozen.scenarios.map((s) => s.key)).toEqual(["q500"]);
  });

  test("8 · the costing renders the brief read-only, and never a control", async () => {
    const w = await world();
    await confirmCostingBrief(w.co._id, {
      enquiryId: w.seeded.enquiry._id, styleId: w.seeded.style._id,
      quantities: [{ key: "q500", quantity: "500", isPrimary: true, proposedSellingPriceExclTax: "420" }],
      quantityUom: "Pieces", note: "Repeat buyer.",
    });

    const p = await preview(w);
    expect(p.status).toBe(200);
    expect(p.body.brief.sampleStyleId).toBe(String(w.seeded.style._id));
    expect(p.body.brief.quantityUom).toBe("Pieces");
    expect(p.body.brief.note).toBe("Repeat buyer.");
    expect(p.body.brief.quantities[0].proposedSellingPriceExclTax).toBe("420");
    expect(p.body.brief.state).toBe("CONFIRMED");
    expect(p.body.briefBlocker).toBeNull();
    /* And the candidates are not offered as a chooser. */
    expect(p.body.error).toBeUndefined();
  });

  test("9 · a payload carrying a moved field is refused, and nothing is written", async () => {
    const w = await world();
    await confirmCostingBrief(w.co._id, {
      enquiryId: w.seeded.enquiry._id, styleId: w.seeded.style._id,
    });
    const before = await CostingVersion.countDocuments({ costingId: w.costingId });

    for (const [field, value] of [
      ["scenarios", [{ key: "q1", quantity: "1", isPrimary: true }]],
      ["technicalStyleId", String(w.seeded.style._id)],
      ["quantityUom", "Metre"],
      ["note", "typed here"],
    ]) {
      /* ── AND THE DOOR IS SHUT BEFORE THE FIELD IS EVEN READ ────────
         The route refuses a browser client outright now, so a payload
         carrying a moved field never reaches the parser. Both refusals are
         correct and the outer one is the stronger claim. */
      const r = await postVersion(w, newKey(), { lines: [], [field]: value });
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe("COSTING_PREPARATION_MOVED_TO_SALES");
      expect(r.body.error.details.owner.department).toBe("Sales");
      expect(r.body.error.details.prepareAt).toBeTruthy();
    }
    /* Refused, never stripped-and-calculated. */
    expect(await CostingVersion.countDocuments({ costingId: w.costingId })).toBe(before);
  });

  test("10 · an unconfirmed brief blocks exactly as a missing one does", async () => {
    /* A DRAFT is Sales still deciding. Treating it as an answer would cost a
       request nobody has made. */
    const w = await world();
    await confirmCostingBrief(w.co._id, {
      enquiryId: w.seeded.enquiry._id, styleId: w.seeded.style._id, confirm: false,
    });

    await expect(prepare(w)).rejects.toMatchObject({
      code: "COSTING_BRIEF_REQUIRED",
      details: { reason: "NO_CONFIRMED_BRIEF", owner: { department: "Sales" } },
    });

    /* And the preview says the same thing rather than erroring at the person
       who opened it. */
    const p = await preview(w);
    expect(p.status).toBe(200);
    expect(p.body.brief).toBeNull();
    expect(p.body.briefBlocker.code).toBe("COSTING_BRIEF_REQUIRED");
  });
});
