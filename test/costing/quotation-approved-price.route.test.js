// test/costing/quotation-approved-price.route.test.js
//
// THE QUOTATION ROUTE, PRICED FROM AN APPROVED COSTING.
//
// The line schema said its `costingSource` was server-stamped. It was not: the
// save route spread `...item` and calculated from the submitted `unitPrice`, so
// a browser could post any figure beside a `costingSource` naming a real
// approved version, and the saved quotation would claim a costing had approved
// a number nobody costed.
//
// These go through the REAL route. A test that called the pricing service
// directly would prove the service and leave the forgery path open, which is
// the exact gap this closes.
"use strict";
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

/* Source assertions read intent, not commentary: a rule named only in a
   comment is not a rule. */
const bare = (t) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const Employee = require("../../models/Employee");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DeptUser = require("../../models/Access/DeptUser");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");
const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");
const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
const CostingVersion = require("../../models/CMS_Models/Costing/CostingVersion");
const {
  seedSourceBacked, configureProduction, approveFinancingPolicy,
  EVERY_FAMILY, prepareForCosting, confirmCommercialLine } = require("./helpers/sourceBacked");
const Costing = require("../../models/CMS_Models/Costing/Costing");

let server, costingBase, salesBase, seq = 0;
const { MongoMemoryReplSet } = require("mongodb-memory-server");
let rs;

jest.setTimeout(240000);

beforeAll(async () => {
  await mongoose.disconnect();
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(rs.getUri(), { dbName: "quotation_handoff" });

  const app = express();
  app.use(express.json());
  app.use("/api/costings", require("../../routes/CMS_Routes/Costing/costings"));
  /* The quotation router expects an authenticated employee. Its own auth
     middleware is applied at mount time in `server.js`; here the identity is
     injected so the test exercises the ROUTE's logic rather than the sign-in. */
  app.use("/api/sales", (req, _res, next) => { req.user = app.locals.actor; next(); },
    require("../../routes/CMS_Routes/Sales/quotationRoutes"));
  await new Promise((r) => { server = app.listen(0, r); });
  const port = server.address().port;
  costingBase = `http://127.0.0.1:${port}/api/costings`;
  salesBase = `http://127.0.0.1:${port}/api/sales`;
  global.__app = app;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  if (rs) await rs.stop();
});

const newKey = () => `qh-${++seq}-${Math.random().toString(36).slice(2)}`;

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

const company = (name) =>
  Acc_Company.create({ companyName: `${name} ${++seq}`, booksFromDate: new Date("2026-04-01") });

async function actor(companies = []) {
  const n = ++seq;
  const email = `qh-${n}@test.example`;
  const emp = await Employee.create({
    firstName: "Q", lastName: `L${n}`, email, biometricId: `QH${n}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  await DeptUser.create({
    name: "Admin", email, passwordHash: "x", isAdmin: true, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  for (const co of companies) {
    await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "Q" });
  }
  return {
    emp, email,
    user: { id: String(emp._id), email, name: "Q Actor", employeeId: emp.biometricId },
    token: jwt.sign(
      { id: String(emp._id), email, name: "Q Actor", role: "employee", employeeId: emp.biometricId },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "30m" },
    ),
  };
}

const POLICY = {
  baseCurrency: "INR", roundingMode: "HALF_UP", sellingPriceIncrementMinor: 100,
  /* Overhead used to arrive as a typed OVERHEAD line in the fixture. It is a
     company RULE, and the engine applies it from here — which is where it was
     always supposed to come from. */
  /* ── NO OVERHEAD ON THIS BODY ─────────────────────────────────────
     It was here, and the costing policy refuses it now: overhead is a Board
     policy with an effective date and an approver. The fixture approves one
     through `configureProduction`, at the same 12% of DIRECT_PLUS_FIXED this
     line used to set — so every figure this suite asserts is unchanged. */
  revision: 0,
};

/* ── THE COSTING IS ASSEMBLED, NOT TYPED ───────────────────────────
   `FULL_LINES` stood here: eight rows, each carrying a rate and a declared
   override, posted to `POST /versions` to give this suite an approved costing
   to quote from. Overrides are retired, so the same fixture is built the way a
   real one is — an enquiry product with a technical record and a supplier
   quotation behind it, which the server assembles into a costed version from
   `lines: []`.

   This suite is about the QUOTATION handoff, so what the costing contains only
   has to be real. That it is now assembled rather than typed is the point of
   the fixture change and not the subject of a single assertion below. */
const SCENARIOS = [{ key: "q500", label: "500 pcs", quantity: "500", isPrimary: true }];

/** A company with an approved costing, and a customer request to quote on. */
async function world({ approve = true } = {}) {
  const co = await company("QHandoff");
  const me = await actor([co]);
  global.__app.locals.actor = me.user;

  await costing("/policy/current", { method: "PUT", token: me.token, company: co._id, body: POLICY });

  /* ── EVERY FAMILY ANSWERED, BY A RECORD ──────────────────────────────
     This suite needs an APPROVED costing, and a costing cannot be submitted
     for review while a cost family is outstanding. The old fixture answered
     all eight by typing a line for each. The records answer them now: the
     Board's financing methodology, the enquiry's payment terms and delivery
     arrangement, and a quotation behind the packaging, the outside service
     and the development work. Duty is the one family with no source, and it
     is answered by a decision with a reason. */
  await approveFinancingPolicy(co._id);
  const seeded = await seedSourceBacked(co._id, { brief: { quantities: SCENARIOS, quantityUom: "Pieces" }, ...EVERY_FAMILY });
  await configureProduction(co._id);
  const style = seeded.style;

  const made = await costing("/", {
    method: "POST", token: me.token, company: co._id, idempotencyKey: newKey(),
    body: { context: seeded.context },
  });
  const costingId = made.body.costing.id;
  /* ── PREPARED THE WAY SALES DOES ──────────────────────────────────────
     `POST /:id/versions` was Calculate and refuses a browser client now. This
     fixture only ever needed a calculated version to exist; the orchestration
     makes one from the confirmed brief and the same sources. */
  const calc = await prepareForCosting(costingId);
  if (calc.status !== 201) throw new Error(`calculate refused: ${calc.status} ${JSON.stringify(calc.body).slice(0, 400)}`);
  const versionId = calc.body.versions[0].id;

  if (approve) {
    const sub = await costing(`/${costingId}/versions/${versionId}/submit`, {
      method: "POST", token: me.token, company: co._id, idempotencyKey: newKey(), body: {},
    });
    if (sub.status !== 200) throw new Error(`submit refused: ${sub.status} ${JSON.stringify(sub.body).slice(0, 600)}`);
    const a = await costing(`/${costingId}/versions/${versionId}/approve`, {
      method: "POST", token: me.token, company: co._id, idempotencyKey: newKey(), body: { note: "Approved." },
    });
    if (a.status !== 200) throw new Error(`approve refused: ${a.status} ${JSON.stringify(a.body).slice(0, 500)}`);
  }

  /* ── AND THE QUANTITY SALES CONFIRMED ─────────────────────────────────
     A quotation line's quantity is read from the commercial line, not from
     the request body, and a style with none is refused rather than priced.
     Confirmed here, after approval, because confirming supersedes the brief
     with a single-quantity one of its own and this suite reads the `q500`
     scenario off the version already frozen above. */
  await confirmCommercialLine(co._id, {
    enquiryId: seeded.context.primaryId, styleId: style._id, quantity: 500,
  });

  const request = await CustomerRequest.create({
    requestId: `REQ-${++seq}`, customerInfo: { name: "Acme" },
  });
  return { co, me, style, seeded, costingId, versionId, request };
}

/* The one approved price a scenario carries. Costings approved under the
   retired band had three; this reads the floor, which is what every version
   calculated since the pricing-floor policy has. */
const approvedPriceMinor = async (versionId, quantity = 500) => {
  const v = await CostingVersion.findById(versionId).lean();
  /* ── FOUND BY QUANTITY, NOT BY KEY ────────────────────────────────────
     The scenario KEY is not the fixture's to predict any more. A version
     calculated from a brief this suite wrote carries `q500`; one the
     commercial line drove carries its own. The quantity is the thing both
     agree on, and the thing this assertion is actually about. */
  const scenario = v.scenarios.find((x) => Number(x.quantity) === Number(quantity))
    || v.scenarios.find((x) => x.isPrimary) || v.scenarios[0];
  return scenario.floor.floorPriceMinor;
};

/** The only two fields a browser may say about an approved price. */
const sourcedItem = (w, over = {}) => ({
  itemName: w.seeded.product, quantity: 500, unitPrice: 0,
  costingIntent: { sampleStyleId: String(w.style._id), tier: "floor" },
  ...over,
});

const save = (w, items, extra = {}) =>
  sales(`/requests/${w.request._id}/quotation`, {
    method: "POST", token: w.me.token,
    /* `validUntil` is what the route stores as the request's validity; without
       it the cast fails and the save 500s. Nothing to do with costing — the
       real popup always sends one. */
    body: {
      items, currency: "INR", status: "draft",
      validUntil: new Date(Date.now() + 30 * 864e5).toISOString(),
      ...extra,
    },
  });

const send = (w) =>
  sales(`/requests/${w.request._id}/quotation/send`, { method: "POST", token: w.me.token, body: {} });

const savedLine = async (w, i = 0) => {
  const r = await CustomerRequest.findById(w.request._id).lean();
  return r.quotations[0].items[i];
};


/* ═══ 1 · THE SERVER PRICES IT ════════════════════════════════════════════ */

describe("saving a quotation line from an approved costing", () => {
  test("the approved floor price is resolved and stored by the server", async () => {
    const w = await world();
    const r = await save(w, [sourcedItem(w)]);
    expect(r.status).toBe(200);

    const item = await savedLine(w);
    const expected = await approvedPriceMinor(w.versionId);
    /* Posted as 0; stored as the approved figure, in major units, converted
       once. */
    expect(item.unitPrice).toBe(expected / 100);
    expect(item.basePrice).toBe(expected / 100);
    expect(item.costingSource.source).toBe("APPROVED_COSTING");
    expect(item.costingSource.costingVersionId.toString()).toBe(w.versionId);
    expect(item.costingSource.priceTier).toBe("floor");
    expect(item.costingSource.unitPriceMinor).toBe(expected);
    expect(item.costingSource.quantity).toBe("500");
    expect(item.sampleStyleId.toString()).toBe(String(w.style._id));
    /* And the quotation's own arithmetic ran on the resolved figure. */
    expect(item.priceBeforeGST).toBeCloseTo((expected / 100) * 500, 2);
  });

  test("a retired tier asked of a floor-priced costing is refused, not answered", async () => {
    /* ── THE FAILURE THIS PREVENTS ────────────────────────────────────
       Answering a request for "target" with the floor would put a number on a
       quotation under a name the costing never calculated — and "target" and
       "floor" are commercially different claims about the same figure. The
       refusal names the reason so a client can react to a company-policy
       change rather than to a generic error. */
    const w = await world();
    for (const tier of ["minimum", "target", "preferred"]) {
      const r = await save(w, [sourcedItem(w, {
        costingIntent: { sampleStyleId: String(w.style._id), tier },
      })]);
      expect([tier, r.status]).toEqual([tier, 422]);
      /* The code, wherever the route carries it — what matters is that the
         refusal names THIS reason and not a generic pricing failure, so a
         client can tell "your company changed its pricing model" from "that
         quantity is not approved". */
      expect([tier, JSON.stringify(r.body)]).toEqual([
        tier, expect.stringContaining("PRICE_TIER_RETIRED"),
      ]);
    }
    /* And nothing was written for any of them. */
    const request = await CustomerRequest.findById(w.request._id).lean();
    expect((request.quotations || []).length === 0
      || (request.quotations[0].items || []).length === 0).toBe(true);
  });

  test("the floor resolves, and it is the figure the version froze", async () => {
    const w = await world();
    const r = await save(w, [sourcedItem(w)]);
    expect(r.status).toBe(200);
    const item = await savedLine(w);
    expect(item.unitPrice).toBe((await approvedPriceMinor(w.versionId)) / 100);
    expect(item.costingSource.priceTier).toBe("floor");
  });

  test("a forged price, version, fingerprint and provenance are all discarded", async () => {
    const w = await world();
    const real = await approvedPriceMinor(w.versionId);
    const r = await save(w, [sourcedItem(w, {
      /* Everything a hopeful client could send. */
      unitPrice: 9, basePrice: 9,
      costingSource: {
        source: "APPROVED_COSTING",
        costingId: new mongoose.Types.ObjectId(),
        costingVersionId: new mongoose.Types.ObjectId(),
        costingVersionNumber: 99,
        scenarioKey: "forged", quantity: "1", priceTier: "target",
        unitPriceMinor: 900, currency: "INR", fingerprint: "f".repeat(32),
      },
      sampleStyleId: new mongoose.Types.ObjectId(),
    })]);
    expect(r.status).toBe(200);

    const item = await savedLine(w);
    /* ── THE CLAIM THIS FILE EXISTS FOR ─────────────────────────────────
       A forged price must never be stored as approved-costing provenance. */
    expect(item.unitPrice).toBe(real / 100);
    expect(item.unitPrice).not.toBe(9);
    expect(item.costingSource.unitPriceMinor).toBe(real);
    expect(item.costingSource.costingVersionNumber).not.toBe(99);
    expect(item.costingSource.scenarioKey).toBe("q500");
    expect(item.costingSource.fingerprint).not.toBe("f".repeat(32));
    expect(item.sampleStyleId.toString()).toBe(String(w.style._id));
  });

  test("a costingSource with no intent is stripped, not honoured", async () => {
    const w = await world();
    const r = await save(w, [{
      itemName: "Typed", quantity: 500, unitPrice: 9,
      /* No `costingIntent` at all — just a provenance the client invented. */
      costingSource: {
        source: "APPROVED_COSTING", costingVersionNumber: 7,
        unitPriceMinor: 900, currency: "INR", fingerprint: "x".repeat(32),
      },
    }]);
    expect(r.status).toBe(200);
    const item = await savedLine(w);
    /* The manual price stands, and it carries NO provenance — a line that was
       never linked has nothing to claim. */
    expect(item.unitPrice).toBe(9);
    expect(item.costingSource?.source).toBeUndefined();
    expect(item.costingSource?.fingerprint).toBeUndefined();
  });

  test("an exact quantity is required, and never the nearest break", async () => {
    /* ── REACHED THE ONLY WAY IT NOW CAN BE ───────────────────────────
       A line cannot simply ask for 1200: the quantity comes from the
       commercial line. So the commercial line MOVES to 1200 — the costing
       follows it and goes back for a new version — and the question is what
       happens in the window before one is approved. The answer must be "no
       approved price for this quantity", never the 500 break's price. */
    const w = await world();
    await confirmCommercialLine(w.co._id, {
      enquiryId: w.seeded.context.primaryId, styleId: w.style._id, quantity: 1200,
    });

    const r = await save(w, [sourcedItem(w, { quantity: 1200 })]);
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("QUOTATION_COSTING_UNAVAILABLE");
    expect(r.body.lines[0].code).toBe("QUOTATION_LINE_NO_APPROVED_QUANTITY");
    expect(r.body.lines[0].message).toMatch(/No approved price exists for this quantity/);
    expect(r.body.lines[0].availableQuantities).toEqual(["500"]);
    /* Nothing was written. */
    const doc = await CustomerRequest.findById(w.request._id).lean();
    expect(doc.quotations).toHaveLength(0);
  });

  test("a currency mismatch refuses rather than converting", async () => {
    const w = await world();
    const r = await save(w, [sourcedItem(w)], { currency: "USD" });
    expect(r.status).toBe(422);
    expect(r.body.lines[0].code).toBe("QUOTATION_LINE_CURRENCY_MISMATCH");
    expect(r.body.lines[0].approvedCurrency).toBe("INR");
  });

  test("a missing tier is refused with something to do about it", async () => {
    const w = await world();
    const r = await save(w, [sourcedItem(w, { costingIntent: { sampleStyleId: String(w.style._id) } })]);
    expect(r.status).toBe(422);
    expect(r.body.lines[0].code).toBe("QUOTATION_LINE_TIER_REQUIRED");
  });

  test("another company's style is refused without saying whether it exists", async () => {
    const w = await world();
    const stranger = await world();
    global.__app.locals.actor = w.me.user;
    const r = await save(w, [sourcedItem(w, {
      costingIntent: { sampleStyleId: String(stranger.style._id), tier: "floor" },
    })]);
    expect(r.status).toBe(422);

    /* ── THE GUARANTEE IS INDISTINGUISHABILITY, NOT A PARTICULAR CODE ──
       Asserted as what it is: the answer for a REAL style belonging to
       somebody else is byte-for-byte the answer for a style id that was
       invented. Neither says which of the two it was, so a caller cannot
       use this door to discover another company's styles. */
    const invented = await save(w, [sourcedItem(w, {
      costingIntent: { sampleStyleId: String(new mongoose.Types.ObjectId()), tier: "floor" },
    })]);
    expect(invented.status).toBe(422);
    expect(r.body.lines[0].code).toBe(invented.body.lines[0].code);
    expect(r.body.lines[0].message).toBe(invented.body.lines[0].message);

    /* And nothing of the stranger's leaks either way. */
    expect(JSON.stringify(r.body)).not.toContain(String(stranger.costingId));
    expect(JSON.stringify(r.body)).not.toContain(String(stranger.co._id));
  });

  test("an unapproved costing offers nothing", async () => {
    const w = await world({ approve: false });
    const r = await save(w, [sourcedItem(w)]);
    expect(r.status).toBe(422);
    expect(r.body.lines[0].code).toBe("QUOTATION_LINE_NO_APPROVED_VERSION");
  });

  test("switching to manual removes the provenance rather than leaving it attached", async () => {
    const w = await world();
    await save(w, [sourcedItem(w)]);
    expect((await savedLine(w)).costingSource.source).toBe("APPROVED_COSTING");

    /* Sales deliberately switches to a typed price: no intent, a new figure. */
    const r = await save(w, [{ itemName: "Oxford Shirt", quantity: 500, unitPrice: 777 }]);
    expect(r.status).toBe(200);
    const item = await savedLine(w);
    expect(item.unitPrice).toBe(777);
    /* An old provenance left on a freshly typed price would say a costing
       approved a number nobody costed. */
    expect(item.costingSource?.source).toBeUndefined();
  });

  test("a manual-only quotation is untouched by any of this", async () => {
    const w = await world();
    const r = await save(w, [{ itemName: "Legacy line", quantity: 10, unitPrice: 250 }]);
    expect(r.status).toBe(200);
    const item = await savedLine(w);
    expect(item.unitPrice).toBe(250);
    expect(item.priceBeforeGST).toBe(2500);
    expect(item.costingSource?.source).toBeUndefined();
  });
});


/* ═══ 2 · NOTHING REACHES A CUSTOMER UNCHECKED ════════════════════════════ */

describe("sending a quotation priced from a costing", () => {
  async function supersede(w) {
    /* Sales adds the second run size to the brief. The quantities are
       theirs, so a fixture that used to post a wider scenario set states
       it where they state it. */
    const enq2 = await Enquiry.findById(w.seeded.enquiry._id);
    enq2.costingBriefs[0].quantities = [
      { key: "q500", label: "500 pcs", quantity: "500", isPrimary: true },
      { key: "q2000", label: "2000 pcs", quantity: "2000", isPrimary: false },
    ];
    enq2.markModified("costingBriefs");
    await enq2.save();
    /* ── A LATER VERSION OF THE SAME SOURCES ──────────────────────────
       The old fixture superseded by adding a typed material row. A fixture
       cannot add a row by hand any more, so the second version costs an
       ADDITIONAL run size — a real second calculation, and one the engine
       prices differently because the fixed costs dilute across 2,000 rather
       than 500.

       `q500` is kept and stays primary, because the quotation being repriced
       below asks for 500 pieces: a supersession that removed the quantity
       under it would be testing a missing scenario rather than a stale
       source. Sales states the run sizes on the brief, so the fixture states
       them there and asks for the estimate again. */
    const calc = await prepareForCosting(w.costingId);
    const v2 = calc.body.versions[0].id;
    await costing(`/${w.costingId}/versions/${v2}/submit`, {
      method: "POST", token: w.me.token, company: w.co._id, idempotencyKey: newKey(), body: {},
    });
    const a = await costing(`/${w.costingId}/versions/${v2}/approve`, {
      method: "POST", token: w.me.token, company: w.co._id, idempotencyKey: newKey(), body: { note: "Revised." },
    });
    expect(a.status).toBe(200);
    return v2;
  }

  test("a draft whose source is current sends", async () => {
    const w = await world();
    await save(w, [sourcedItem(w)]);
    const r = await send(w);
    expect(r.status).toBe(200);
    const doc = await CustomerRequest.findById(w.request._id).lean();
    expect(doc.quotations[0].status).toBe("sent_to_customer");
  });

  test("a draft whose source has been superseded is refused, with what to do", async () => {
    const w = await world();
    await save(w, [sourcedItem(w)]);
    await supersede(w);

    const r = await send(w);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("QUOTATION_SOURCE_SUPERSEDED");
    expect(r.body.lines[0].message).toMatch(/Approved source has been superseded/);
    expect(r.body.lines[0].message).toMatch(/switch it to a manual price/);
    /* Not silently repriced, and not sent. */
    const doc = await CustomerRequest.findById(w.request._id).lean();
    expect(doc.quotations[0].status).toBe("draft");
    expect(doc.quotations[0].items[0].costingSource.costingVersionId.toString()).toBe(w.versionId);
  });

  test("saving straight to sent reprices from the current approval, so nothing stale goes out", async () => {
    const w = await world();
    await save(w, [sourcedItem(w)]);
    const v2 = await supersede(w);

    /* The popup can post the status directly and skip Send entirely. That
       door is guarded too — but it cannot actually carry a STALE source,
       because a save with an intent reprices against whatever is approved
       now. So the outcome is a send at the CURRENT price, not a refusal. */
    const r = await save(w, [sourcedItem(w)], { status: "sent_to_customer" });
    expect(r.status).toBe(200);

    const doc = await CustomerRequest.findById(w.request._id).lean();
    const item = doc.quotations[0].items[0];
    expect(doc.quotations[0].status).toBe("sent_to_customer");
    /* Repriced against v2, not sent at v1's figure. */
    expect(item.costingSource.costingVersionId.toString()).toBe(v2);
    expect(item.costingSource.costingVersionId.toString()).not.toBe(w.versionId);
    expect(item.unitPrice).toBe((await approvedPriceMinor(v2)) / 100);
  });

  test("a line whose stored source went stale cannot be sent by any route", async () => {
    const w = await world();
    await save(w, [sourcedItem(w)]);
    await supersede(w);

    /* The stored line still names v1 — nothing has repriced it. Both doors
       must refuse it. */
    const viaSend = await send(w);
    expect(viaSend.status).toBe(409);
    expect(viaSend.body.code).toBe("QUOTATION_SOURCE_SUPERSEDED");

    const doc = await CustomerRequest.findById(w.request._id).lean();
    expect(doc.quotations[0].status).toBe("draft");
    expect(doc.quotations[0].items[0].costingSource.costingVersionId.toString()).toBe(w.versionId);
  });

  /* ── AN UNANSWERED CHECK IS NOT A FINDING OF CHANGE ────────────────────
     `verifyBeforeSend`'s UNVERIFIABLE branch was written and never driven.
     It is reached without a spy: a saved line keeps the costing id it was
     stamped with, and `supersessionFor` cannot resolve that costing in this
     company — so the honest answer is "we do not know", never "still
     current" and never "superseded".

     The difference is the whole point. Superseded is permanent and needs a
     decision; unverifiable is transient and needs a retry. Reporting the
     second as the first sends somebody to re-approve a costing that never
     moved. */
  test("a source that cannot be read blocks the send as UNVERIFIABLE, not as superseded", async () => {
    const w = await world();
    await save(w, [sourcedItem(w)]);

    /* The stamp stays exactly as the server wrote it; what goes is the
       costing it points at. This is a real state — a costing removed, or a
       line carried into a company that cannot see its source. */
    const before = await savedLine(w);
    expect(before.costingSource.costingId).toBeTruthy();
    await Costing.collection.deleteOne({ _id: new mongoose.Types.ObjectId(String(before.costingSource.costingId)) });

    const r = await send(w);
    /* 503 and retryable — not the 409 a superseded source gets. */
    expect(r.status).toBe(503);
    expect(r.body.code).toBe("QUOTATION_SOURCE_UNVERIFIABLE");
    expect(r.body.retryable).toBe(true);
    expect(r.body.lines[0].code).toBe("QUOTATION_SOURCE_UNVERIFIABLE");
    expect(r.body.lines[0].retryable).toBe(true);
    /* It never claims the source changed. */
    expect(r.body.message).toMatch(/could not be checked/i);
    expect(r.body.message).not.toMatch(/superseded|has changed/i);

    /* Nothing was sent, nothing was repriced, and nothing quietly became a
       manual line. */
    const doc = await CustomerRequest.findById(w.request._id).lean();
    expect(doc.quotations[0].status).toBe("draft");
    expect(doc.quotations[0].items[0].costingSource.source).toBe("APPROVED_COSTING");
    expect(doc.quotations[0].items[0].costingSource.unitPriceMinor)
      .toBe(before.costingSource.unitPriceMinor);
  });

  /* The OTHER send door — posting `status: 'sent_to_customer'` straight to the
     save route — is closed by a different mechanism, and the distinction is
     worth pinning rather than assuming.

     A save always REPRICES from the intent, and a client's own provenance is
     deleted before anything is read. So a stale stamp cannot travel through
     this door at all: with an unreadable costing the INTENT fails to resolve
     and the save is refused at pricing, before any status change. Same
     outcome — nothing sent — reached earlier and for a more precise reason. */
  test("saving straight to sent cannot round the check: the intent itself refuses", async () => {
    const w = await world();
    await save(w, [sourcedItem(w)]);
    const before = await savedLine(w);
    await Costing.collection.deleteOne({ _id: new mongoose.Types.ObjectId(String(before.costingSource.costingId)) });

    const r = await save(w, [sourcedItem(w)], { status: "sent_to_customer" });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("QUOTATION_COSTING_UNAVAILABLE");
    expect(r.body.lines[0].code).toBe("QUOTATION_LINE_NO_COSTING");

    /* Nothing was sent, and the previously saved line was not overwritten. */
    const doc = await CustomerRequest.findById(w.request._id).lean();
    expect(doc.quotations[0].status).toBe("draft");
    expect(doc.quotations[0].items[0].costingSource.unitPriceMinor)
      .toBe(before.costingSource.unitPriceMinor);
  });

  test("a manual line is never blocked by any of this", async () => {
    const w = await world();
    await save(w, [{ itemName: "Typed", quantity: 10, unitPrice: 100 }]);
    const r = await send(w);
    expect(r.status).toBe(200);
  });

  test("an already-sent quotation keeps the version and price actually sent", async () => {
    const w = await world();
    await save(w, [sourcedItem(w)]);
    await send(w);
    const sentPrice = (await savedLine(w)).unitPrice;

    await supersede(w);

    const doc = await CustomerRequest.findById(w.request._id).lean();
    const item = doc.quotations[0].items[0];
    /* A sent quotation is historical evidence of what was offered. Restating
       it because a costing changed afterwards would falsify the offer. */
    expect(doc.quotations[0].status).toBe("sent_to_customer");
    expect(item.unitPrice).toBe(sentPrice);
    expect(item.costingSource.costingVersionId.toString()).toBe(w.versionId);
  });

  test("a line edited away from its approved quantity cannot be sent", async () => {
    const w = await world();
    await save(w, [sourcedItem(w)]);
    /* The quantity is changed directly, as an edit that bypassed repricing
       would leave it: the stamp still says 500. */
    await CustomerRequest.collection.updateOne(
      { _id: w.request._id }, { $set: { "quotations.0.items.0.quantity": 900 } },
    );
    const r = await send(w);
    expect(r.status).toBe(409);
    expect(r.body.lines[0].message).toMatch(/approved for 500/);
  });
});

/* ═══ 4 · WHAT THE STATUS CODE ITSELF SAYS ═══════════════════════════════ */

describe("a refusal's status distinguishes a conflict from a malformed line", () => {
  /**
   * ── THE DISTINCTION ───────────────────────────────────────────────────────
   * Every refusal here used to be 422. That conflated two different things a
   * caller must do about them.
   *
   * A line that names a quantity nobody confirmed, or one whose costing has
   * not caught up, is WELL-FORMED and no longer true: the document submitted
   * disagrees with the commercial state as it stands right now, and the fix is
   * to re-read that state. That is 409.
   *
   * A missing tier, or a costing that offers nothing for this line, is an
   * incomplete or inapplicable input. Re-reading changes nothing about it, and
   * it stays 422.
   *
   * Neither writes anything: the refusal is for the whole request, and the
   * per-line detail is carried in both.
   */

  /** Move the confirmed quantity and approve a costing for it. */
  async function reapproveFor(w, quantity) {
    await confirmCommercialLine(w.co._id, {
      enquiryId: w.seeded.context.primaryId, styleId: w.style._id, quantity,
    });
    const calc = await prepareForCosting(w.costingId);
    if (calc.status !== 201) throw new Error(`calculate refused: ${calc.status}`);
    const v = calc.body.versions[0].id;
    await costing(`/${w.costingId}/versions/${v}/submit`, {
      method: "POST", token: w.me.token, company: w.co._id, idempotencyKey: newKey(), body: {},
    });
    const a = await costing(`/${w.costingId}/versions/${v}/approve`, {
      method: "POST", token: w.me.token, company: w.co._id, idempotencyKey: newKey(), body: { note: "For 750." },
    });
    if (a.status !== 200) throw new Error(`approve refused: ${a.status}`);
    return v;
  }

  test("a forged 500 against a confirmed 750 is a CONFLICT", async () => {
    const w = await world();
    await reapproveFor(w, 750);

    /* Well-formed, and the number a stale tab would still be showing. */
    const r = await save(w, [sourcedItem(w, { quantity: 500 })]);

    expect(r.status).toBe(409);
    expect(r.body.code).toBe("QUOTATION_COMMERCIAL_STATE_CONFLICT");
    /* The per-line detail survives the status change — the caller is still
       told which line, and both numbers. */
    expect(r.body.lines[0].code).toBe("QUOTATION_LINE_QUANTITY_NOT_CONFIRMED");
    expect(r.body.lines[0].confirmedQuantity).toBe(750);
    expect(r.body.lines[0].submittedQuantity).toBe(500);
    expect(r.body.lines[0].index).toBe(0);

    /* And nothing was written. */
    const doc = await CustomerRequest.findById(w.request._id).lean();
    expect(doc.quotations).toHaveLength(0);
  });

  test("a commercial line its costing has not caught up with is a CONFLICT", async () => {
    const w = await world();

    /* The recoverable boundary: the line commits, the costing fails to
       follow. The quantity submitted is the confirmed one — the disagreement
       is between the line and its own costing. */
    const costingBrief = require("../../services/sales/costingBrief.service");
    jest.spyOn(costingBrief, "confirmBrief").mockImplementationOnce(() => {
      throw new Error("simulated failure after the commercial line was written");
    });
    await confirmCommercialLine(w.co._id, {
      enquiryId: w.seeded.context.primaryId, styleId: w.style._id, quantity: 750,
    });
    jest.restoreAllMocks();

    const r = await save(w, [sourcedItem(w, { quantity: 750 })]);

    expect(r.status).toBe(409);
    expect(r.body.code).toBe("QUOTATION_COMMERCIAL_STATE_CONFLICT");
    expect(r.body.lines[0].code).toBe("QUOTATION_LINE_COSTING_NOT_IN_SYNC");

    const doc = await CustomerRequest.findById(w.request._id).lean();
    expect(doc.quotations).toHaveLength(0);
  });

  test("a line missing the tier it must name is UNPROCESSABLE, not a conflict", async () => {
    /* Nothing here disagrees with commercial state. The client said half a
       thing, and reloading the order would not complete it. */
    const w = await world();
    const r = await save(w, [sourcedItem(w, {
      costingIntent: { sampleStyleId: String(w.style._id) },
    })]);

    expect(r.status).toBe(422);
    expect(r.body.code).toBe("QUOTATION_COSTING_UNAVAILABLE");
    expect(r.body.lines[0].code).toBe("QUOTATION_LINE_TIER_REQUIRED");
  });

  test("a quantity that is not a number is UNPROCESSABLE, not a conflict", async () => {
    /* It disagrees with the confirmed 500 too, but it is malformed FIRST —
       and a 409 would tell the caller to reload, which fixes nothing. */
    const w = await world();
    const r = await save(w, [sourcedItem(w, { quantity: "several" })]);

    expect(r.status).toBe(422);
    expect(r.body.code).toBe("QUOTATION_COSTING_UNAVAILABLE");
    expect(r.body.lines[0].code).toBe("QUOTATION_LINE_QUANTITY_INVALID");

    const doc = await CustomerRequest.findById(w.request._id).lean();
    expect(doc.quotations).toHaveLength(0);
  });

  test("a mixed request is unprocessable, because reloading is not the whole fix", async () => {
    const w = await world();
    await reapproveFor(w, 750);

    const r = await save(w, [
      /* A conflict… */
      sourcedItem(w, { quantity: 500 }),
      /* …and a line that named no tier. */
      sourcedItem(w, { quantity: 750, costingIntent: { sampleStyleId: String(w.style._id) } }),
    ]);

    expect(r.status).toBe(422);
    /* Both refusals are still carried, each by its own name. */
    expect(r.body.lines.map((l) => l.code)).toEqual([
      "QUOTATION_LINE_QUANTITY_NOT_CONFIRMED",
      "QUOTATION_LINE_TIER_REQUIRED",
    ]);
  });

  test("the matching 750 saves, and the stored quantity is the server's", async () => {
    const w = await world();
    const v = await reapproveFor(w, 750);

    const r = await save(w, [sourcedItem(w, { quantity: 750 })]);
    expect(r.status).toBe(200);

    const item = await savedLine(w);
    expect(Number(item.quantity)).toBe(750);
    expect(item.costingSource.quantity).toBe("750");
    expect(item.costingSource.costingVersionId.toString()).toBe(v);
    expect(item.unitPrice).toBe((await approvedPriceMinor(v, 750)) / 100);
  });

  test("the status split is decided once, for both save doors", () => {
    /* Two doors post quotation lines. A status chosen separately at each
       would be two answers to one question, and the second would drift. */
    const route = bare(fs.readFileSync(
      path.join(__dirname, "../../routes/CMS_Routes/Sales/quotationRoutes.js"), "utf8",
    ));
    expect(route.split("quotationPricing.refusalFor(").length - 1).toBe(2);
    expect(route).not.toMatch(/res\.status\(422\)[\s\S]{0,120}QUOTATION_COSTING_UNAVAILABLE/);

    /* ── AND ONLY COMMERCIAL-STATE REFUSALS ARE CONFLICTS ──────────────
       Each of these says the same thing in a different way: the document
       submitted is well-formed and no longer true, and re-reading the current
       state is the whole fix. The line names a quantity nobody confirmed; the
       costing has not caught up with the quantity they did; or — for a
       proforma raised from Cost & Invoicing — the approved commercial
       decision behind the line has moved since it was raised.

       Pinned as a SET, so a code cannot be added to it casually: everything
       else here is an incomplete or inapplicable input, and reloading changes
       nothing about those. They stay unprocessable-entity. */
    const quotationPricing = require("../../services/centralCosting/quotationPricing.service");
    expect([...quotationPricing.CONFLICT_CODES].sort()).toEqual([
      "QUOTATION_LINE_COSTING_NOT_IN_SYNC",
      "QUOTATION_LINE_QUANTITY_NOT_CONFIRMED",
      "QUOTATION_LINE_SALES_DECISION_CHANGED",
    ]);
  });
});
