// test/costing/sourcing-decisions.route.test.js
//
// STORE CHOOSES THE SUPPLIER. COSTING READS THE CHOICE.
//
// ── THE OWNERSHIP THIS PINS ─────────────────────────────────────────────────
// When several quotations can price one requirement, somebody must choose.
// That choice used to be `quotationChoices`: a `{lineKey: offerId}` map in
// React state, posted with the calculation, belonging to nobody and surviving
// nothing. It was a real commercial decision — lead time, capacity, quality
// history, terms — made by whoever happened to be costing a garment.
//
// It is Store's, it is recorded, and it is revalidated on every read. These
// tests are about all three, and about the one failure mode that would make
// the change worse than the thing it replaced: a stale decision quietly
// pricing a costing from a quotation that no longer applies.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const Employee = require("../../models/Employee");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DeptUser = require("../../models/Access/DeptUser");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const Vendor = require("../../models/CMS_Models/Inventory/Vendor-Buyer/Vendor");
const SupplierOffer = require("../../models/CMS_Models/Inventory/Sourcing/SupplierOffer");
const ServiceSupplierOffer = require("../../models/CMS_Models/Inventory/Sourcing/ServiceSupplierOffer");
const CostingVersion = require("../../models/CMS_Models/Costing/CostingVersion");
const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
const SourcingDecision = require("../../models/CMS_Models/Inventory/Sourcing/SourcingDecision");

const { seedSourceBacked, configureProduction, prepareForCosting } = require("./helpers/sourceBacked");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/costings", require("../../routes/CMS_Routes/Costing/costings"));
  app.use("/api/sourcing-decisions", require("../../routes/CMS_Routes/Inventory/Sourcing/sourcingDecisions"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const newKey = () => `sd-${++seq}-${Math.random().toString(36).slice(2)}`;

const call = (path, { method = "GET", body, token, idempotencyKey, company } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      ...(company ? { "X-Costing-Company": String(company), "X-Company-Id": String(company) } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

const POLICY = {
  baseCurrency: "INR", roundingMode: "HALF_UP", sellingPriceIncrementMinor: 100,
  /* ── NO OVERHEAD HERE ────────────────────────────────────────────────
     `overheadBasis` and `overheadRatePercent` were on this body and are
     refused now: overhead is a Board policy with an effective date and an
     approver, and the costing policy will only accept them being CLEARED.

     Nothing in this suite needs an overhead line — every assertion is about
     which quotation prices a requirement — so the honest fixture is one that
     does not claim a rate the Board has not approved. */
  /* The GST treatment is an approved Board decision now; the costing policy
     refuses the field. `configureProduction` approves the fixture's, at the
     same RECOVERABLE this used to write. */
  revision: 0,
};

const ONE = [{ key: "q500", label: "500", quantity: "500", isPrimary: true }];

/**
 * An actor, with the Store grants named explicitly.
 *
 * `sourcing` decides, `viewer` may only look. Both are real Store grants
 * resolved the way every other Store route resolves them — nothing here
 * invents a role, and platform administration is not quietly commercial
 * authority.
 */
async function actor(co, { sourcing = true } = {}) {
  const n = ++seq;
  const email = `srcdec-${n}@test.example`;
  const emp = await Employee.create({
    firstName: "Buyer", lastName: `L${n}`, email, biometricId: `SD${n}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  await DeptUser.create({
    name: "Buyer", email, passwordHash: "x", isAdmin: true, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  await SpCompanyMembership.create({
    companyId: co._id, email, employeeRef: emp._id, personName: "Buyer",
    isActive: true,
    ...(sourcing ? {} : { role: "viewer" }),
  });
  return {
    emp,
    token: jwt.sign(
      { id: String(emp._id), email, name: `Buyer ${n}`, role: "employee", employeeId: emp.biometricId },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "30m" },
    ),
  };
}

/** A second quotation for the seeded material, so the requirement is ambiguous. */
async function secondMaterialOffer(co, itemId, { price = 39900, name = "Mill B", over = {} } = {}) {
  const v = await Vendor.create({
    companyId: co._id, companyName: `${name} ${++seq}`, vendorType: "Supplier", status: "Active",
  });
  return SupplierOffer.create({
    companyId: co._id, supplierId: v._id, supplierName: v.companyName,
    itemId, purchaseUom: "Metre", currency: "INR",
    unitPriceMinor: price, priceBasis: "TAX_EXCLUSIVE", gstRatePercent: 12,
    freightTerms: "INCLUSIVE_LANDED",
    quotationReference: `Q-${++seq}`,
    /* A competing Indian mill for the same fabric — this suite is about which
       quotation Store CHOOSES, so both candidates state their sourcing.
       Leaving it unanswered blocks the costing on a customs question instead
       of exercising the choice, and `over` still lets a test make one of them
       an import deliberately. */
    sourcing: { type: "DOMESTIC" },
    status: "ACTIVE", effectiveFrom: new Date("2026-01-01"),
    ...over,
  });
}

async function world({ seedOver = {}, sourcing = true } = {}) {
  const co = await Acc_Company.create({
    companyName: `Sourcing ${++seq}`, booksFromDate: new Date("2026-04-01"),
  });
  const me = await actor(co, { sourcing });
  expect((await call("/api/costings/policy/current", {
    method: "PUT", token: me.token, company: co._id, body: POLICY,
  })).status).toBe(200);

  const seeded = await seedSourceBacked(co._id, { brief: { quantities: ONE, quantityUom: "Pieces" }, ...seedOver });
  await configureProduction(co._id);

  const made = await call("/api/costings", {
    method: "POST", token: me.token, company: co._id, idempotencyKey: newKey(),
    body: { context: seeded.context },
  });
  expect(made.status).toBe(201);
  return { co, me, seeded, costingId: made.body.costing.id };
}

/* ── PREPARED THE WAY SALES DOES ──────────────────────────────────────────
   `POST /:id/versions` was Calculate and refuses a browser client now. A body
   carrying an actual LINE is a payload-contract test and still goes to the
   retired door, whose refusal is the contract now; everything else is asked
   for the way Sales asks. */
const payloadContract = (body = {}, lines = []) => Object.keys(body).some((k) => k !== "lines")
  || (Array.isArray(lines) && lines.length > 0)
  || (Array.isArray(body.lines) && body.lines.length > 0);

const calc = (w, body = {}) => (payloadContract(body)
  ? call(`/api/costings/${w.costingId}/versions`, {
    method: "POST", token: w.me.token, company: w.co._id, idempotencyKey: newKey(),
    body: { lines: [], ...body },
  })
  : prepareForCosting(w.costingId));

const queue = (w) => call("/api/sourcing-decisions", { token: w.me.token, company: w.co._id });
const forCosting = (w) => call(`/api/sourcing-decisions/costing/${w.costingId}`,
  { token: w.me.token, company: w.co._id });
const decide = (w, lineKey, offerId, extra = {}) =>
  call(`/api/sourcing-decisions/costing/${w.costingId}`, {
    method: "POST", token: w.me.token, company: w.co._id, idempotencyKey: newKey(),
    body: { lineKey, offerId: String(offerId), ...extra },
  });
const undecide = (w, lineKey) =>
  call(`/api/sourcing-decisions/costing/${w.costingId}?lineKey=${encodeURIComponent(lineKey)}`,
    { method: "DELETE", token: w.me.token, company: w.co._id });

/* ═══ 1 · ONE QUOTATION STILL RESOLVES ITSELF ════════════════════════════ */

describe("exactly one applicable quotation", () => {
  test("is attached automatically, and asks nobody anything", async () => {
    /* ── THE BEHAVIOUR THIS CHANGE MUST NOT BREAK ──────────────────────
       Most requirements have one quotation. Sending every one of them to a
       decision queue would turn a working automatic path into a person's
       inbox, and the queue would be so full of non-decisions that the real
       ones would be invisible. */
    const w = await world();
    const r = await calc(w);
    expect(r.status).toBe(201);

    const line = r.body.versions[0].cost.inputs
      .find((l) => l.lineKey === w.seeded.materialLineKey);
    expect(line.confidence).toBe("SUPPLIER_QUOTATION");

    /* And nothing was recorded, because nothing was decided. */
    expect(await SourcingDecision.countDocuments({ companyId: w.co._id })).toBe(0);
    expect((await queue(w)).body.decisions).toEqual([]);
  });
});

/* ═══ 2 · SEVERAL REQUIRE STORE ═════════════════════════════════════════ */

describe("several applicable quotations", () => {
  test("block the costing, and appear in Store's queue with their candidates", async () => {
    const w = await world();
    await secondMaterialOffer(w.co, w.seeded.item._id);

    const blocked = await calc(w);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.details.owner.department).toBe("Store");
    expect(await CostingVersion.countDocuments({ costingId: w.costingId, versionNumber: 2 })).toBe(0);

    const q = await queue(w);
    expect(q.status).toBe(200);
    const row = q.body.decisions.find((d) => d.lineKey === w.seeded.materialLineKey);
    expect(row).toBeTruthy();
    expect(row.kind).toBe("MATERIAL");
    expect(row.candidates).toHaveLength(2);
    /* Store's own screen, so the commercial facts are here. */
    for (const c of row.candidates) {
      expect(c.offerId).toBeTruthy();
      expect(c.supplierName).toBeTruthy();
      expect(c.quotationReference).toBeTruthy();
    }
    /* And nothing is pre-picked. Choosing the cheapest is a sourcing decision
       with a person's name on it. */
    expect(row.candidates.some((c) => c.selected || c.recommended)).toBe(false);
  });

  test("Store's choice unblocks the costing, and the version cites that quotation", async () => {
    const w = await world();
    const second = await secondMaterialOffer(w.co, w.seeded.item._id);

    const row = (await queue(w)).body.decisions
      .find((d) => d.lineKey === w.seeded.materialLineKey);
    const chosen = row.candidates.find((c) => String(c.offerId) === String(second._id));
    expect(chosen).toBeTruthy();

    const made = await decide(w, w.seeded.materialLineKey, second._id, {
      note: "Shorter lead time and they hold stock.",
    });
    expect(made.status).toBe(201);
    expect(made.body.decision.decidedByActorName).toBeTruthy();
    expect(made.body.decision.decidedAt).toBeTruthy();
    expect(made.body.decision.context.candidateCount).toBe(2);
    expect(made.body.decision.note).toMatch(/lead time/);

    /* The costing now calculates, from the quotation Store named. */
    const r = await calc(w);
    expect(r.status).toBe(201);
    const prov = r.body.versions[0].cost.offerProvenance
      .find((p) => p.lineKey === w.seeded.materialLineKey);
    expect(String(prov.offerId)).toBe(String(second._id));
  });

  test("the queue is empty once every requirement is decided", async () => {
    const w = await world();
    const second = await secondMaterialOffer(w.co, w.seeded.item._id);
    await decide(w, w.seeded.materialLineKey, second._id);
    expect((await queue(w)).body.decisions).toEqual([]);
  });

  test("withdrawing a decision puts the requirement back", async () => {
    const w = await world();
    const second = await secondMaterialOffer(w.co, w.seeded.item._id);
    await decide(w, w.seeded.materialLineKey, second._id);

    const back = await undecide(w, w.seeded.materialLineKey);
    expect(back.status).toBe(200);
    expect((await queue(w)).body.decisions).toHaveLength(1);
    expect((await calc(w)).status).toBe(409);

    /* Withdrawn, not deleted: a supplier choice that was reversed is a thing
       people ask about. */
    const rows = await SourcingDecision.find({ companyId: w.co._id }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe("WITHDRAWN");
  });

  test("a second choice supersedes the first rather than overwriting it", async () => {
    const w = await world();
    const second = await secondMaterialOffer(w.co, w.seeded.item._id);
    await decide(w, w.seeded.materialLineKey, second._id);
    await undecide(w, w.seeded.materialLineKey);
    await decide(w, w.seeded.materialLineKey, w.seeded.offer._id);

    const rows = await SourcingDecision.find({ companyId: w.co._id }).sort({ decidedAt: 1 }).lean();
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.state === "ACTIVE")).toHaveLength(1);
    expect(String(rows.find((r) => r.state === "ACTIVE").offerId)).toBe(String(w.seeded.offer._id));
  });
});

/* ═══ 3 · SERVICES, DEVELOPMENT AND FREIGHT USE THE SAME WORKFLOW ════════ */

describe("every family that has a quotation register", () => {
  test("an outside service with two quotations is a Store decision", async () => {
    const w = await world({
      seedOver: {
        service: {
          quantity: 1, unit: "Piece", basis: "PER_GARMENT", rateMinor: 800,
          second: { rateMinor: 700 },
        },
      },
    });
    const row = (await queue(w)).body.decisions
      .find((d) => d.lineKey === w.seeded.serviceLineKey);
    expect(row).toBeTruthy();
    expect(row.kind).toBe("SERVICE");
    expect(row.candidates.length).toBeGreaterThan(1);

    const made = await decide(w, w.seeded.serviceLineKey, w.seeded.secondServiceOffer._id);
    expect(made.status).toBe(201);
    expect(made.body.decision.offerKind).toBe("SERVICE_SUPPLIER_OFFER");
  });

  test("development work bought outside is its own kind, not an ordinary service", async () => {
    /* Same register, same decision shape — and named apart because it dilutes
       across the run instead of scaling with it, so a buyer choosing for it is
       answering a different question. */
    const w = await world({
      seedOver: {
        development: {
          internal: false, unit: "Lot", quantity: 1, rateMinor: 1000000,
          second: { rateMinor: 900000 },
        },
      },
    });
    const row = (await queue(w)).body.decisions
      .find((d) => d.lineKey === w.seeded.developmentLineKey);
    expect(row).toBeTruthy();
    expect(row.kind).toBe("DEVELOPMENT");

    const made = await decide(w, w.seeded.developmentLineKey, w.seeded.devServiceOffer._id);
    expect(made.status).toBe(201);
    expect(made.body.decision.subject.kind).toBe("DEVELOPMENT");
  });

  test("packaging is sourced the same way a material is", async () => {
    const w = await world({
      seedOver: { packaging: { quantity: 1, unit: "Piece", basis: "PER_GARMENT", rateMinor: 250 } },
    });
    await secondMaterialOffer(w.co, w.seeded.packagingItem._id, {
      price: 220, name: "Packer B", over: { purchaseUom: "Piece" },
    });

    const row = (await queue(w)).body.decisions
      .find((d) => d.lineKey === w.seeded.packagingLineKey);
    expect(row).toBeTruthy();
    expect(row.kind).toBe("PACKAGING");
    expect(row.subject.itemId).toBeTruthy();
  });
});

/* ═══ 4 · THE DECISION IS REVALIDATED, NEVER TRUSTED ════════════════════ */

describe("a decision that has gone stale", () => {
  /** Withdraw a live quotation through its own lifecycle, as Store would. */
  const withdrawOffer = async (offer) => {
    const doc = await SupplierOffer.findById(offer._id);
    const { beginOfferLifecycle } = SupplierOffer;
    beginOfferLifecycle(doc, "WITHDRAW");
    doc.status = "WITHDRAWN";
    await doc.save();
  };

  test("a withdrawn quotation makes the requirement unresolved, never substituted", async () => {
    /* ── THE FAILURE THIS EXISTS TO PREVENT ────────────────────────────
       A saved decision silently falling back to "the other one". The costing
       would calculate, the total would move, and the version would cite a
       supplier nobody chose. */
    const w = await world();
    const second = await secondMaterialOffer(w.co, w.seeded.item._id);
    await decide(w, w.seeded.materialLineKey, second._id);
    expect((await calc(w)).status).toBe(201);

    await withdrawOffer(second);

    const r = await calc(w);
    expect(r.status).toBeGreaterThanOrEqual(400);
    /* Not priced from the surviving quotation. */
    const versions = await CostingVersion.find({ costingId: w.costingId }).lean();
    const priced = versions.flatMap((v) => v.offerProvenance || [])
      .filter((p) => p.lineKey === w.seeded.materialLineKey);
    expect(priced.every((p) => String(p.offerId) === String(second._id))).toBe(true);
  });

  test("the queue says which decision went stale, and what it was made against", async () => {
    const w = await world();
    const second = await secondMaterialOffer(w.co, w.seeded.item._id);
    await decide(w, w.seeded.materialLineKey, second._id);
    await withdrawOffer(second);

    const row = (await queue(w)).body.decisions
      .find((d) => d.lineKey === w.seeded.materialLineKey);
    expect(row).toBeTruthy();
    expect(row.staleDecision).toBeTruthy();
    expect(String(row.staleDecision.offerId)).toBe(String(second._id));
    /* "Choose again" with no information in it is not an instruction. */
    expect(row.staleDecision.decidedByActorName).toBeTruthy();
    expect(row.staleDecision.decidedAt).toBeTruthy();

    /* ── AND THE QUANTITY IS HONESTLY EMPTY HERE ──────────────────────
       A costing that has never calculated has no run sizes, so the first
       decision on an ambiguous requirement is necessarily judged without
       one — the candidates are the quotations CURRENT for the item, and
       applicability against a minimum or a tier is settled later, at
       calculation, where a decision that does not hold reopens.

       Recording "" rather than a plausible number is the point: a quantity
       nobody judged must not read as one somebody did. */
    expect(row.staleDecision.judgedQuantity).toBe("");
  });

  test("a quantity that no longer reaches the tier reopens the decision", async () => {
    /* The decision records the run size it was judged at precisely so it
       cannot silently answer a different one. */
    const w = await world();
    const second = await secondMaterialOffer(w.co, w.seeded.item._id, {
      over: { moq: 400 },
    });
    await decide(w, w.seeded.materialLineKey, second._id);
    expect((await calc(w)).status).toBe(201);

    /* ── AND THE RUN SIZE IS SALES' TO CHANGE ─────────────────────────
       This posted a smaller scenario with the calculation. Quantities are the
       Sales costing brief's now, so the change is made there — which is also
       the truthful version of the scenario: a customer asking for 50 instead
       of 500 is a commercial change, not a costing one.

       One garment needs one metre, so a run of 50 is below the 400 minimum. */
    const enquiry = await Enquiry.findById(w.seeded.enquiry._id);
    enquiry.costingBriefs[0].quantities = [
      { key: "q50", label: "50", quantity: "50", isPrimary: true },
    ];
    enquiry.markModified("costingBriefs");
    await enquiry.save();

    const small = await calc(w);
    expect(small.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(small.body)).toMatch(/minimum|applic/i);
  });

  test("a superseded quotation reopens it, and the successor is not assumed", async () => {
    /* ── REVISION IS NOT A SUBSTITUTION ────────────────────────────────
       Revising a quotation supersedes it with a NEW document at a new rate.
       The obvious shortcut — follow the chain and price from the successor —
       is exactly the silent substitution this must not do: Store chose a
       supplier at a price, and the successor is a different price they have
       not agreed to yet.

       A quotation expiring is the same shape of event, judged the same way
       against the costing's own date, and it reopens for the same reason. */
    const w = await world();
    const second = await secondMaterialOffer(w.co, w.seeded.item._id);
    await decide(w, w.seeded.materialLineKey, second._id);
    expect((await calc(w)).status).toBe(201);

    const doc = await SupplierOffer.findById(second._id);
    const { beginOfferLifecycle } = SupplierOffer;
    beginOfferLifecycle(doc, "SUPERSEDE");
    doc.status = "SUPERSEDED";
    await doc.save();

    const r = await calc(w);
    expect(r.status).toBeGreaterThanOrEqual(400);
    /* And it did not quietly become the other supplier's costing. */
    const latest = await CostingVersion.findOne({ costingId: w.costingId })
      .sort({ versionNumber: -1 }).lean();
    const prov = (latest.offerProvenance || [])
      .find((p) => p.lineKey === w.seeded.materialLineKey);
    expect(String(prov?.offerId ?? "")).toBe(String(second._id));
  });
});

/* ═══ 5 · FROZEN VERSIONS KEEP WHAT THEY USED ═══════════════════════════ */

describe("a frozen version", () => {
  test("keeps its quotation after the live decision is withdrawn", async () => {
    const w = await world();
    const second = await secondMaterialOffer(w.co, w.seeded.item._id);
    await decide(w, w.seeded.materialLineKey, second._id);

    const r = await calc(w);
    expect(r.status).toBe(201);
    const versionId = r.body.versions[0].id;
    const before = await CostingVersion.findById(versionId).lean();

    await undecide(w, w.seeded.materialLineKey);

    const after = await CostingVersion.findById(versionId).lean();
    expect(after.offerProvenance).toEqual(before.offerProvenance);
    const prov = after.offerProvenance.find((p) => p.lineKey === w.seeded.materialLineKey);
    expect(String(prov.offerId)).toBe(String(second._id));
    expect(prov.supplierName).toBeTruthy();
    expect(prov.quotationReference).toBeTruthy();

    /* And it still READS, which is the whole point of freezing it. */
    const read = await call(`/api/costings/${w.costingId}/versions`,
      { token: w.me.token, company: w.co._id });
    expect(read.status).toBe(200);
    const shown = read.body.versions.find((v) => v.id === versionId);
    expect(shown.cost.offerProvenance
      .find((p) => p.lineKey === w.seeded.materialLineKey).supplierName).toBeTruthy();
  });
});

/* ═══ 6 · WHO MAY DECIDE, AND WHOSE COMPANY IT IS ═══════════════════════ */

describe("access and isolation", () => {
  test("another company's costing is not found, not refused", async () => {
    const mine = await world();
    const theirs = await world();
    await secondMaterialOffer(theirs.co, theirs.seeded.item._id);

    const peek = await call(`/api/sourcing-decisions/costing/${theirs.costingId}`,
      { token: mine.me.token, company: mine.co._id });
    expect(peek.status).toBe(404);
    /* Missing and foreign read the same: the shape of an id must not become
       an oracle for which costings exist. */
    expect(JSON.stringify(peek.body)).not.toMatch(/company|permission|forbidden/i);
  });

  test("a company's queue contains only its own requirements", async () => {
    const mine = await world();
    const theirs = await world();
    await secondMaterialOffer(theirs.co, theirs.seeded.item._id);
    await secondMaterialOffer(mine.co, mine.seeded.item._id);

    const q = await queue(mine);
    expect(q.body.decisions.every((d) => d.costingId === mine.costingId)).toBe(true);
  });

  test("a quotation belonging to another company cannot be chosen", async () => {
    const mine = await world();
    const theirs = await world();
    await secondMaterialOffer(mine.co, mine.seeded.item._id);

    const r = await decide(mine, mine.seeded.materialLineKey, theirs.seeded.offer._id);
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("SOURCING_DECISION_OFFER_NOT_APPLICABLE");
    expect(await SourcingDecision.countDocuments({ companyId: mine.co._id })).toBe(0);
  });

  test("a quotation that does not apply to the requirement is refused", async () => {
    const w = await world();
    await secondMaterialOffer(w.co, w.seeded.item._id);
    /* A live quotation for a DIFFERENT item. Real, this company's, and not an
       answer to this requirement. */
    const other = await world();
    const strayItem = other.seeded.item._id;
    const stray = await secondMaterialOffer(w.co, strayItem, { name: "Elsewhere" });

    const r = await decide(w, w.seeded.materialLineKey, stray._id);
    expect(r.status).toBe(422);
    expect(r.body.error.details.reason).toBe("OFFER_NOT_APPLICABLE");
  });

  test("a Store viewer may read the queue and may not decide", async () => {
    /* ── THE GRANT BOUNDARY, ON THE REAL CONVENTION ────────────────────
       `sp.read` to look, `sp.sourcing.manage` to decide — the identical pair
       that already governs writing a quotation down, because the same people
       who record what a supplier offered are the people who choose between
       them. Nothing here invents a role.

       Looking is deliberately open to a viewer: a buyer who cannot see what
       is outstanding cannot prepare for the conversation with the supplier. */
    const w = await world();
    const second = await secondMaterialOffer(w.co, w.seeded.item._id);

    const n = ++seq;
    const email = `viewer-${n}@test.example`;
    const emp = await Employee.create({
      firstName: "Viewer", lastName: `L${n}`, email, biometricId: `SDV${n}`,
      isActive: true, gender: "Other", department: "Tech",
    });
    /* NOT a platform administrator — that grant carries the Store write set
       and would prove nothing about the department role. */
    await DeptUser.create({
      name: "Viewer", email, passwordHash: "x", isAdmin: false, isActive: true,
      departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
    });
    await SpCompanyMembership.create({
      companyId: w.co._id, email, employeeRef: emp._id, personName: "Viewer", isActive: true,
    });
    await DepartmentRole.create({
      email, departmentSlug: "store", role: "viewer", isActive: true,
    });
    const token = jwt.sign(
      { id: String(emp._id), email, name: "Viewer", role: "employee", employeeId: emp.biometricId },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "30m" },
    );

    const seen = await call("/api/sourcing-decisions", { token, company: w.co._id });
    expect(seen.status).toBe(200);
    expect(seen.body.decisions.length).toBeGreaterThan(0);
    /* And the screen is told not to offer the control, rather than offering
       one that would be refused. */
    expect(seen.body.canDecide).toBe(false);

    const refused = await call(`/api/sourcing-decisions/costing/${w.costingId}`, {
      method: "POST", token, company: w.co._id, idempotencyKey: newKey(),
      body: { lineKey: w.seeded.materialLineKey, offerId: String(second._id) },
    });
    expect(refused.status).toBe(403);
    expect(await SourcingDecision.countDocuments({ companyId: w.co._id })).toBe(0);
  });

  test("a requirement nobody is waiting on cannot be decided", async () => {
    /* ── ONCE THE RUN SIZES EXIST, ONE QUOTATION RESOLVES ITSELF ──────
       The costing is calculated first, deliberately. Before that it has no
       run sizes, and a requirement whose applicability cannot be judged is
       legitimately open for Store to settle early. After it, the single
       quotation is attached automatically and there is nothing to decide —
       and a screen that recorded a decision anyway would show a choice the
       costing never asked for. */
    const w = await world();
    expect((await calc(w)).status).toBe(201);
    expect((await queue(w)).body.decisions).toEqual([]);

    const r = await decide(w, w.seeded.materialLineKey, w.seeded.offer._id);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("SOURCING_DECISION_NOT_OPEN");
  });
});

/* ═══ 7 · COSTING NO LONGER CARRIES THE CHOICE ══════════════════════════ */

describe("the calculation payload", () => {
  test("a client-supplied quotation choice is refused and pointed at Store", async () => {
    /* ── A STALE BROWSER, WHICH IS THE REALISTIC CASE ──────────────────
       Silently dropping it would calculate from whatever Store decided —
       possibly a different supplier — while the person who pressed Calculate
       believes they chose. Right, and unexplainable. */
    const w = await world();
    const second = await secondMaterialOffer(w.co, w.seeded.item._id);
    await decide(w, w.seeded.materialLineKey, second._id);

    const r = await calc(w, {
      quotationChoices: { [w.seeded.materialLineKey]: String(w.seeded.offer._id) },
    });
    /* Refused at the door — the route reads no body at all now. The
    parser's own refusal, which names Store and its destination, is
    asserted directly: the rule keeps a test even with no route that
    can carry a choice to it. */
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("COSTING_PREPARATION_MOVED_TO_SALES");
    const { refuseQuotationChoices } = require("../../services/centralCosting/calculationInput");
    let told = null;
    try {
      refuseQuotationChoices({
        quotationChoices: { [w.seeded.materialLineKey]: String(w.seeded.offer._id) },
      });
    } catch (err) { told = err; }
    expect(told.code).toBe("COSTING_QUOTATION_CHOICE_MOVED");
    expect(told.details.owner.department).toBe("Store");
    /* A refusal with no address is what sends people looking for another way
       in. */
    expect(told.details.decideAt).toMatch(/store/i);

    /* And it was refused rather than applied: nothing was written. */
    expect(await CostingVersion.countDocuments({ costingId: w.costingId, versionNumber: 2 })).toBe(0);
  });

  test("an empty choices object is refused too", async () => {
    /* An empty map is still a client that believes it owns this decision, and
       the next build of it will send a full one. */
    const w = await world();
    const r = await calc(w, { quotationChoices: {} });
    /* Refused at the door — the route reads no body at all now. The
    parser's own refusal, which names Store and its destination, is
    asserted directly: the rule keeps a test even with no route that
    can carry a choice to it. */
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("COSTING_PREPARATION_MOVED_TO_SALES");
    const { refuseQuotationChoices } = require("../../services/centralCosting/calculationInput");
    let told = null;
    try { refuseQuotationChoices({ quotationChoices: {} }); } catch (err) { told = err; }
    expect(told.code).toBe("COSTING_QUOTATION_CHOICE_MOVED");
  });

  test("the parser refuses it without a database", () => {
    const { parseCalculationRequest } = require("../../services/centralCosting/calculationInput");
    /* No scenarios: quantities are the Sales brief's, and a payload carrying
       them is refused before this refusal is reached. */
    expect(() => parseCalculationRequest({
      lines: [], quotationChoices: { "mat:x::": "abc" },
    }, { currency: "INR", assembled: true })).toThrow(/Store/i);
  });
});
