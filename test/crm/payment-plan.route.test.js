// test/crm/payment-plan.route.test.js
//
// THE PAYMENT PLAN: WHAT THE CUSTOMER USUALLY AGREES, AND WHAT ONE DEAL DID.
//
// The rows this replaces were a name and a percentage — "Advance Payment 60%
// / Final Payment 40%" — and they never said WHEN. "Final Payment 40%" is 40%
// before dispatch, or on delivery, or 30 days after the invoice; three
// different agreements costing three different amounts to finance, and
// nothing in the row told them apart.
//
// What is pinned here:
//
//   · a tranche says how much, against which event, and how far from it;
//   · the shares add to exactly 100% or the plan is refused;
//   · an enquiry COPIES the customer's plan and resolves its dates against
//     its own order — and a later change to the customer cannot restate it;
//   · financing is one sum per tranche, never one average;
//   · a record written before plans existed prices exactly as it always did,
//     and its calculation says so.
"use strict";

const express = require("express");
const mongoose = require("mongoose");

jest.mock("../../Middlewear/SalesAuthMiddlewear", () => (req, res, next) => {
  const raw = req.headers["x-test-user"];
  if (!raw) return res.status(401).json({ success: false, message: "Authentication required." });
  req.user = JSON.parse(raw);
  next();
});
jest.mock("../../config/firebaseAdmin", () => ({ messaging: () => ({ send: async () => ({}) }) }));
jest.mock("../../services/NotificationService", () => ({
  notify: async () => ({}), notifyUser: async () => ({}), send: async () => ({}),
}));
jest.mock("../../services/departmentNotify.service", () => ({
  notifyEvent: async () => ({}), APP_URL: "http://localhost",
}));
jest.mock("../../services/cowork.service", () => ({}), { virtual: true });
jest.mock("../../services/coworkSheets.service", () => ({}), { virtual: true });
jest.mock("../../services/changeLog", () => ({
  ...jest.requireActual("../../services/changeLog"),
  recordChange: jest.fn().mockResolvedValue(undefined),
}));

const Account = require("../../models/CMS_Models/Sales/Account");
const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const paymentTermsResolution = require("../../services/sales/paymentTermsResolution.service");
const plans = require("../../services/sales/paymentPlan.service");
const financing = require("../../services/centralCosting/financing.service");

const oid = () => new mongoose.Types.ObjectId();
const USER = { id: oid().toString(), name: "Anita Rao", role: "sales" };

let server;
let accountsBase;
let enquiriesBase;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/crm/accounts", require("../../routes/CMS_Routes/Sales/accounts"));
  app.use("/api/cms/crm/enquiries", require("../../routes/CMS_Routes/Sales/enquiries"));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  const root = `http://127.0.0.1:${server.address().port}/api/cms/crm`;
  accountsBase = `${root}/accounts`;
  enquiriesBase = `${root}/enquiries`;
});
afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });

async function call(root, path, { method = "GET", body, user = USER } = {}) {
  const res = await fetch(`${root}${path}`, {
    method,
    headers: { "Content-Type": "application/json", "x-test-user": JSON.stringify(user) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json() };
}
const onAccount = (path, opt) => call(accountsBase, path, opt);
const onEnquiry = (path, opt) => call(enquiriesBase, path, opt);

let CO;
let seq = 0;

beforeEach(async () => {
  await Promise.all([
    Account.collection.deleteMany({}), Enquiry.collection.deleteMany({}),
    SpCompanyMembership.deleteMany({}),
  ]);
  const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
  await Acc_Company.deleteMany({});
  CO = await Acc_Company.create({ companyName: "Plan Co", booksFromDate: new Date("2026-04-01") });
  await SpCompanyMembership.create({ companyId: CO._id, employeeRef: USER.id, personName: USER.name });
});

async function customer(defaults = {}) {
  seq += 1;
  return Account.create({
    companyId: CO._id, companyName: `Tranche Buyer ${seq}`, status: "active", ...defaults,
  });
}

/** An enquiry that knows when it expects to be ordered and needed. */
async function enquiryFor(account, dates = {}) {
  const _id = oid();
  seq += 1;
  await Enquiry.collection.insertOne({
    _id, enquiryId: `ENQ-P-${seq}`, journeyId: oid(), isActive: true,
    companyId: account.companyId, accountId: account._id, title: "Uniform programme",
    expectedOrderDate: dates.order || new Date("2026-10-01"),
    requirementDeadline: dates.delivery || new Date("2026-12-20"),
  });
  return _id;
}

const storedEnquiry = (id) => Enquiry.collection.findOne({ _id: id });
const storedAccount = (id) => Account.collection.findOne({ _id: id });

const ROW = (over = {}) => ({
  name: "Advance payment", percentage: 60, dueEvent: "ORDER_CONFIRMATION",
  offsetDirection: "ON", offsetDays: 0, ...over,
});
/** The example from the brief: 60% on order confirmation, 40% 30 days after invoice. */
const USUAL = [
  ROW(),
  ROW({ name: "Final payment", percentage: 40, dueEvent: "INVOICE", offsetDirection: "AFTER", offsetDays: 30 }),
];

/* ══ 1 · THE CUSTOMER'S STANDING PLAN ══════════════════════════════════════ */

describe("the customer's usual plan, on the account", () => {
  test("a tranche says how much, against what, and how far from it", async () => {
    const account = await customer();
    const saved = await onAccount(`/${account._id}`, { method: "PATCH", body: { paymentPlan: USUAL } });
    expect(saved.status).toBe(200);

    const stored = await storedAccount(account._id);
    expect(stored.paymentPlan).toHaveLength(2);
    expect(stored.paymentPlan[0]).toMatchObject({
      name: "Advance payment", percentage: 60, dueEvent: "ORDER_CONFIRMATION", offsetDirection: "ON", offsetDays: 0,
    });
    expect(stored.paymentPlan[1]).toMatchObject({
      name: "Final payment", percentage: 40, dueEvent: "INVOICE", offsetDirection: "AFTER", offsetDays: 30,
    });
    /* And it reads back as one sentence, which is what a preview shows. */
    expect(plans.summarise(stored.paymentPlan))
      .toBe("60% due on order confirmation; 40% due 30 days after invoice date.");
  });

  test("the steps have to add up to the whole order", async () => {
    const account = await customer();
    const short = await onAccount(`/${account._id}`, {
      method: "PATCH",
      body: { paymentPlan: [ROW({ percentage: 60 }), ROW({ name: "Final", percentage: 30, dueEvent: "DISPATCH" })] },
    });
    expect(short.status).toBe(400);
    expect(short.body.message).toMatch(/add up to exactly 100%/i);
    expect(short.body.message).toMatch(/no agreed moment to be paid in/i);
    /* Over is its own sentence: it is a different mistake. */
    const over = await onAccount(`/${account._id}`, {
      method: "PATCH",
      body: { paymentPlan: [ROW({ percentage: 60 }), ROW({ name: "Final", percentage: 60, dueEvent: "DISPATCH" })] },
    });
    expect(over.body.message).toMatch(/promises more than the order is worth/i);
    /* Nothing was written by either attempt. */
    expect((await storedAccount(account._id)).paymentPlan ?? null).toBeNull();
  });

  test("an amount with no event is refused, by name", async () => {
    const account = await customer();
    const res = await onAccount(`/${account._id}`, {
      method: "PATCH", body: { paymentPlan: [{ name: "Final payment", percentage: 100 }] },
    });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe("plan[0].dueEvent");
    expect(res.body.message).toMatch(/Final payment/);
    expect(res.body.message).toMatch(/not a payment term/i);
  });

  test("due ON an event cannot also be days from it", async () => {
    const account = await customer();
    const res = await onAccount(`/${account._id}`, {
      method: "PATCH",
      body: { paymentPlan: [ROW({ name: "All of it", percentage: 100, dueEvent: "DISPATCH", offsetDirection: "ON", offsetDays: 30 })] },
    });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe("plan[0].offsetDays");
    expect(res.body.message).toMatch(/due ON that event/i);
  });

  test("before dispatch and on dispatch stay different plans", async () => {
    /* The distinction the old rows could not hold at all, and the reason the
       direction is its own field rather than a signed offset. */
    const a = await customer();
    const b = await customer();
    const rows = (direction) => [
      ROW({ percentage: 40 }),
      ROW({ name: "Balance", percentage: 60, dueEvent: "DISPATCH", offsetDirection: direction, offsetDays: 0 }),
    ];
    await onAccount(`/${a._id}`, { method: "PATCH", body: { paymentPlan: rows("BEFORE") } });
    await onAccount(`/${b._id}`, { method: "PATCH", body: { paymentPlan: rows("ON") } });
    expect((await storedAccount(a._id)).paymentPlan[1].offsetDirection).toBe("BEFORE");
    expect((await storedAccount(b._id)).paymentPlan[1].offsetDirection).toBe("ON");
    /* And each still reads as the named agreement it is. */
    expect((await storedAccount(a._id)).paymentTermsShape).toBe("PART_BEFORE_DISPATCH");
    expect((await storedAccount(b._id)).paymentTermsShape).toBe("PART_ON_DISPATCH");
  });

  test("the one figure the pipeline enforces is kept in step with the plan", async () => {
    /* Production does not start until the agreed advance is received, and
       that gate reads `advancePercent`. It is DERIVED from the plan rather
       than typed beside it — two records of one agreement is one of them
       waiting to be wrong. */
    const account = await customer();
    await onAccount(`/${account._id}`, { method: "PATCH", body: { paymentPlan: USUAL } });
    expect((await storedAccount(account._id)).advancePercent).toBe(60);

    /* A plan with nothing due before production starts is a nil advance —
       an answer, and not the same as no plan. */
    await onAccount(`/${account._id}`, {
      method: "PATCH",
      body: { paymentPlan: [ROW({ name: "On delivery", percentage: 100, dueEvent: "DELIVERY", offsetDirection: "ON" })] },
    });
    expect((await storedAccount(account._id)).advancePercent).toBe(0);
  });

  test("clearing the plan hands the customer back to their figures", async () => {
    const account = await customer();
    await onAccount(`/${account._id}`, { method: "PATCH", body: { paymentPlan: USUAL } });
    const cleared = await onAccount(`/${account._id}`, { method: "PATCH", body: { paymentPlan: [] } });
    expect(cleared.status).toBe(200);
    expect((await storedAccount(account._id)).paymentPlan ?? null).toBeNull();
  });
});

/* ══ 2 · ONE DEAL'S OWN PLAN ═══════════════════════════════════════════════ */

describe("an enquiry copies the plan and dates it against its own order", () => {
  const saveTerms = (id, paymentTerms) => onEnquiry(`/${id}`, { method: "PATCH", body: { paymentTerms } });

  test("the customer's plan is offered whole, and applying it copies every row", async () => {
    const account = await customer({ paymentPlan: USUAL });
    const enquiryId = await enquiryFor(account);

    const offered = (await onEnquiry(`/${enquiryId}/commercial-defaults`)).body.payment;
    expect(offered.available).toBe(true);
    expect(offered.plan).toHaveLength(2);
    expect(offered.planSummary).toMatch(/60% due on order confirmation/);

    const saved = await saveTerms(enquiryId, { plan: offered.plan, confirm: true });
    expect(saved.status).toBe(200);
    const stored = (await storedEnquiry(enquiryId)).paymentTerms;
    expect(stored.plan).toHaveLength(2);
    /* Copied unchanged, so it reads as the customer's own terms rather than
       as something agreed for this order alone. */
    expect(stored.source).toBe("ACCOUNT");
    expect(stored.accountDefaultAtConfirmation.plan).toHaveLength(2);
  });

  test("expected dates are resolved from the order, and only where it knows them", async () => {
    const account = await customer({ paymentPlan: USUAL });
    /* This order expects to be confirmed on 1 October. Nobody has said when
       it will be invoiced. */
    const enquiryId = await enquiryFor(account, { order: new Date("2026-10-01") });
    await saveTerms(enquiryId, { plan: USUAL, confirm: true });

    const stored = (await storedEnquiry(enquiryId)).paymentTerms;
    expect(stored.plan[0].expectedDate.toISOString().slice(0, 10)).toBe("2026-10-01");
    /* NOT counted forward from today onto a customer's proforma. */
    expect(stored.plan[1].expectedDate ?? null).toBeNull();

    /* And the screen is told which date is missing, and who can fix it. */
    const preview = await onEnquiry(`/${enquiryId}/payment-plan`);
    expect(preview.status).toBe(200);
    expect(preview.body.undatedEvents).toEqual(["INVOICE"]);
    expect(preview.body.tranches[1].undatedReason).toMatch(/No invoice date is expected/i);
  });

  test("the preview shows every tranche's working before anybody confirms it", async () => {
    const account = await customer();
    const enquiryId = await enquiryFor(account);
    const three = [
      ROW({ percentage: 60 }),
      ROW({ name: "On dispatch", percentage: 20, dueEvent: "DISPATCH", offsetDirection: "ON" }),
      ROW({ name: "Retention", percentage: 20, dueEvent: "INVOICE", offsetDirection: "AFTER", offsetDays: 45 }),
    ];
    /* Saved, NOT confirmed — the whole point is to be read first. */
    await saveTerms(enquiryId, { plan: three });

    const { body } = await onEnquiry(`/${enquiryId}/payment-plan`);
    expect(body.state).toBe("DRAFT");
    expect(body.shape).toBe("CUSTOM");
    expect(body.tranches.map((t) => t.phrase)).toEqual([
      "60% on order confirmation",
      "20% on dispatch from our warehouse",
      "20% 45 days after invoice date",
    ]);
    /* ── THE DAYS CENTRAL COSTING WILL USE, OR NOTHING ────────────────
       Financing is measured from the Board's own start event to each due
       date. This company has approved no financing policy, so there is no
       start to measure from — and the preview says so rather than showing
       days it has no basis for. */
    expect(body.financingStart.event).toBeNull();
    expect(body.financingStart.policy).toMatch(/Board has not said when the company's money goes out/i);
    expect(body.tranches.map((t) => t.financedDays)).toEqual([null, null, null]);
    /* And no rate, ever: what money costs is the Board's. */
    expect(JSON.stringify(body)).not.toMatch(/annualRate|ratePercent/i);
  });

  test("the preview shows the very days Central Costing will charge for", async () => {
    /* Sales may not see the rate — what money costs is the Board's — but the
       DURATION a price is built on is something the person agreeing the
       terms has to be able to see, and it has to be the same duration. */
    const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
    const BoardPolicy = require("../../models/CMS_Models/Board/BoardPolicy");
    await BoardPolicy.collection.deleteMany({});
    await BoardPolicy.collection.insertOne({
      companyId: CO._id, policyKey: "FINANCING", status: "BOARD_APPROVED",
      effectiveFrom: new Date("2025-01-01"), approvedAt: new Date("2025-01-01"),
      financing: {
        annualRatePercent: "10", basis: "DIRECT",
        advanceTreatment: "REDUCES_FINANCED_AMOUNT", dayCountBasis: 365,
        startEvent: "MATERIAL_COMMITMENT",
      },
      isActive: true,
    });
    expect(await Acc_Company.countDocuments({ _id: CO._id })).toBe(1);

    const account = await customer();
    const enquiryId = await enquiryFor(account);
    /* Material committed 1 January; dispatched 1 March. */
    await Enquiry.collection.updateOne({ _id: enquiryId }, {
      $set: {
        "schedule.materialCommitment": new Date("2026-01-01T00:00:00.000Z"),
        "schedule.dispatch": new Date("2026-03-01T00:00:00.000Z"),
        expectedOrderDate: new Date("2025-12-15T00:00:00.000Z"),
      },
    });
    await saveTerms(enquiryId, {
      plan: [ROW({ percentage: 60 }), ROW({ name: "Balance", percentage: 40, dueEvent: "DISPATCH", offsetDirection: "ON" })],
      confirm: true,
    });

    const { status, body } = await onEnquiry(`/${enquiryId}/payment-plan`);
    if (status !== 200) throw new Error(`preview ${status}: ${JSON.stringify(body)}`);
    expect(body.financingStart).toMatchObject({ event: "MATERIAL_COMMITMENT", label: "Material commitment" });
    expect(new Date(body.financingStart.date).toISOString().slice(0, 10)).toBe("2026-01-01");
    /* 1 January to 1 March — the same 59 days the engine charges for. */
    expect(body.tranches.map((t) => t.financedDays)).toEqual([0, 59]);
    expect(new Date(body.tranches[1].expectedDate).toISOString().slice(0, 10)).toBe("2026-03-01");
    /* And still no money figure anywhere in it. */
    expect(JSON.stringify(body)).not.toMatch(/annualRate|ratePercent|effectivePercent/i);

    await BoardPolicy.collection.deleteMany({});
  });

  test("Sales may depart from the customer's plan for one deal", async () => {
    const account = await customer({ paymentPlan: USUAL });
    const before = JSON.stringify(await storedAccount(account._id));
    const enquiryId = await enquiryFor(account);

    /* This buyer pays in two equal parts, this once. */
    const theirs = [
      ROW({ name: "Half up front", percentage: 50 }),
      ROW({ name: "Half on delivery", percentage: 50, dueEvent: "DELIVERY", offsetDirection: "ON" }),
    ];
    const saved = await saveTerms(enquiryId, { plan: theirs, confirm: true });
    expect(saved.status).toBe(200);

    const stored = (await storedEnquiry(enquiryId)).paymentTerms;
    expect(stored.plan.map((r) => r.percentage)).toEqual([50, 50]);
    /* Legible as a difference from what the customer usually agrees. */
    expect(stored.source).toBe("ENQUIRY");
    expect(stored.accountDefaultAtConfirmation.plan.map((r) => r.percentage)).toEqual([60, 40]);
    /* And the customer's standing plan is exactly as it was. */
    expect(JSON.stringify(await storedAccount(account._id))).toBe(before);
  });

  test("a later change to the customer cannot restate what this order agreed", async () => {
    const account = await customer({ paymentPlan: USUAL });
    const enquiryId = await enquiryFor(account);
    await saveTerms(enquiryId, { plan: USUAL, confirm: true });

    /* The customer renegotiates, months later. */
    const renegotiated = [ROW({ name: "Everything up front", percentage: 100 })];
    expect((await onAccount(`/${account._id}`, { method: "PATCH", body: { paymentPlan: renegotiated } })).status).toBe(200);

    const stored = (await storedEnquiry(enquiryId)).paymentTerms;
    expect(stored.plan).toHaveLength(2);
    expect(stored.plan[1]).toMatchObject({ percentage: 40, dueEvent: "INVOICE", offsetDays: 30 });
    /* Including to costing, which reads this order's own snapshot. */
    const projection = paymentTermsResolution.projectionFor({ paymentTerms: stored });
    expect(projection.state).toBe("CONFIRMED");
    expect(projection.method).toBe("TRANCHE");
    expect(projection.plan).toHaveLength(2);
  });

  test("an edit that says nothing about the plan does not drop it", async () => {
    const account = await customer();
    const enquiryId = await enquiryFor(account);
    await saveTerms(enquiryId, { plan: USUAL, confirm: true });
    /* A note is saved. The instalments are not mentioned, and survive. */
    await saveTerms(enquiryId, { note: "Confirmed by email, 12 Sep." });
    const stored = (await storedEnquiry(enquiryId)).paymentTerms;
    expect(stored.plan).toHaveLength(2);
    /* Though the confirmation is re-opened, as any edit after one is. */
    expect(stored.confirmedAt ?? null).toBeNull();
  });

  test("recording a plan clears the figures it replaces", async () => {
    /* A record written before plans existed, re-agreed as instalments. The
       old advance and credit period do not survive beside the plan: two
       records of one agreement is one of them still readable and wrong. */
    const account = await customer();
    const enquiryId = await enquiryFor(account);
    await Enquiry.collection.updateOne({ _id: enquiryId }, {
      $set: { paymentTerms: { advancePercent: 30, creditDays: 45, creditDaysFrom: "INVOICE" } },
    });

    const saved = await saveTerms(enquiryId, { plan: USUAL, confirm: true });
    expect(saved.status).toBe(200);
    const stored = (await storedEnquiry(enquiryId)).paymentTerms;
    expect(stored.plan).toHaveLength(2);
    expect(stored.advancePercent ?? null).toBeNull();
    expect(stored.creditDays ?? null).toBeNull();
    expect(stored.creditDaysFrom ?? null).toBeNull();
    /* And costing is told which arithmetic prices it now. */
    expect(paymentTermsResolution.projectionFor({ paymentTerms: stored }).method).toBe("TRANCHE");
  });

  test("an incomplete plan cannot be confirmed", async () => {
    const account = await customer();
    const enquiryId = await enquiryFor(account);
    const res = await saveTerms(enquiryId, { plan: [ROW({ percentage: 60 })], confirm: true });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/add up to exactly 100%/i);
    expect((await storedEnquiry(enquiryId)).paymentTerms?.plan ?? null).toBeNull();
  });
});

/* ══ 3 · WHAT IT COSTS TO WAIT ═════════════════════════════════════════════
 *
 * Financing is a calendar distance — from the day the company's money goes
 * out to the day each payment falls due — and both ends are facts about THIS
 * order. An offset says how to DERIVE a due date; it is not a duration.
 *
 * Fixed dates throughout, so every figure below can be checked by hand.
 * ═════════════════════════════════════════════════════════════════════════ */

describe("financing is measured on the calendar, tranche by tranche", () => {
  /* 10% a year, 365-day basis, and the company's money goes out when it
     commits to the fabric. */
  const POLICY = {
    financing: {
      annualRatePercent: "10", basis: "DIRECT",
      advanceTreatment: "REDUCES_FINANCED_AMOUNT", dayCountBasis: 365,
      startEvent: "MATERIAL_COMMITMENT",
    },
  };
  /* Material committed 1 January. */
  const JAN_1 = new Date("2026-01-01T00:00:00.000Z");
  const DATES = {
    MATERIAL_COMMITMENT: JAN_1,
    /* The customer confirmed in December — before the money went out. */
    ORDER_CONFIRMATION: new Date("2025-12-15T00:00:00.000Z"),
    DISPATCH: new Date("2026-03-01T00:00:00.000Z"),
    INVOICE: new Date("2026-03-01T00:00:00.000Z"),
  };
  const confirmed = (paymentTerms) => paymentTermsResolution.projectionFor({
    paymentTerms: { ...paymentTerms, confirmedAt: new Date("2025-12-01"), source: "ENQUIRY" },
  });
  /* 60% on order confirmation, 40% on dispatch. */
  const SPLIT = [
    ROW({ percentage: 60 }),
    ROW({ name: "Balance", percentage: 40, dueEvent: "DISPATCH", offsetDirection: "ON" }),
  ];
  const price = (plan, dates = DATES, policy = POLICY) => financing.compute({
    policy, terms: confirmed({ plan }), dates,
  });

  test("1 · the balance is financed for the actual January-to-March duration", async () => {
    const result = price(SPLIT);
    expect(result.state).toBe("CALCULATED");
    expect(result.working.method).toBe(financing.METHOD.TIMELINE_TRANCHES);
    /* The start, by event and by date. */
    expect(result.working.startEvent).toBe("MATERIAL_COMMITMENT");
    expect(result.working.startDate.toISOString().slice(0, 10)).toBe("2026-01-01");

    const [advance, balance] = result.working.tranches;
    /* 1 January to 1 March is 59 days — the real distance, not "0 days
       after dispatch" and not an offset of any kind. */
    expect(balance.dueDate.toISOString().slice(0, 10)).toBe("2026-03-01");
    expect(balance.financedDays).toBe("59");
    /* 10% x 40% x 59 / 365 = 0.646575% of the basis. */
    expect(balance.effectivePercent).toBe("0.646575");
    /* And the 60% that arrived in December financed nothing. */
    expect(advance.financedDays).toBe("0");
    expect(advance.effectivePercent).toBe("0.000000");
    expect(result.percent).toBe("0.646575");
  });

  test("2 · dispatch slipping to 1 April costs more, because it is more days", async () => {
    const before = price(SPLIT);
    const after = price(SPLIT, { ...DATES, DISPATCH: new Date("2026-04-01T00:00:00.000Z") });
    /* 1 January to 1 April is 90 days: 10% x 40% x 90 / 365 = 0.986301%. */
    expect(after.working.tranches[1].financedDays).toBe("90");
    expect(after.percent).toBe("0.986301");
    expect(Number(after.percent)).toBeGreaterThan(Number(before.percent));
    /* A price that moves when the timeline moves is the point. The offset
       never changed; the order did. */
    expect(after.working.tranches[1].offsetDays).toBe(before.working.tranches[1].offsetDays);
  });

  test("3 · the same 40%, due 30 days after the invoice, uses its own due date", async () => {
    /* Dispatch stays on 1 March; the balance now falls 30 days after the
       invoice, which this order expects on 1 March too. */
    const credit = [
      ROW({ percentage: 60 }),
      ROW({ name: "Balance", percentage: 40, dueEvent: "INVOICE", offsetDirection: "AFTER", offsetDays: 30 }),
    ];
    const result = price(credit);
    const balance = result.working.tranches[1];
    /* Derived: 1 March + 30 days = 31 March. */
    expect(balance.dueDate.toISOString().slice(0, 10)).toBe("2026-03-31");
    /* And financed from 1 January to 31 March — 89 days, not the 30 the
       offset says. 10% x 40% x 89 / 365 = 0.975342%. */
    expect(balance.financedDays).toBe("89");
    expect(result.percent).toBe("0.975342");
  });

  test("4 · a tranche due before the money goes out contributes nothing", async () => {
    /* And is never negative: a payment arriving early is not finance income
       unless somebody decides it is, and nobody has. */
    const early = price([
      ROW({ name: "All of it", percentage: 100 }),
    ]);
    expect(early.working.tranches[0].dueDate.toISOString().slice(0, 10)).toBe("2025-12-15");
    expect(early.working.tranches[0].financedDays).toBe("0");
    expect(early.state).toBe(financing.STATE.RECORDED_ZERO);
    expect(early.percent).toBe("0");
  });

  test("5 · a date nobody has recorded blocks the calculation, and names its owner", async () => {
    /* The start event's own date. */
    const noStart = price(SPLIT, { ...DATES, MATERIAL_COMMITMENT: null });
    expect(noStart.state).toBe(financing.STATE.TERMS_MISSING);
    expect(noStart.percent).toBeNull();
    const startGap = noStart.missing.find((m) => m.code === "FINANCING_START_DATE_MISSING");
    expect(startGap.owner.department).toBe("Store / Purchase");
    expect(startGap.message).toMatch(/material commitment/i);

    /* And a tranche's own event. */
    const noDispatch = price(SPLIT, { ...DATES, DISPATCH: null });
    expect(noDispatch.state).toBe(financing.STATE.TERMS_MISSING);
    const dueGap = noDispatch.missing.find((m) => m.code === "PAYMENT_DUE_DATE_MISSING");
    expect(dueGap.owner.department).toBe("Packaging & Dispatch");
    expect(dueGap.message).toMatch(/dated dispatch/i);

    /* Never a fall back to the offsets, and never a zero: an unanswered
       question is not a cash order. */
    expect(noDispatch.percent).toBeNull();
    expect(noDispatch.working.tranches).toBeNull();
  });

  test("5b · the Board not saying where financing starts is the Board's gap", async () => {
    const result = price(SPLIT, DATES, {
      financing: { ...POLICY.financing, startEvent: undefined },
    });
    expect(result.state).toBe(financing.STATE.POLICY_MISSING);
    expect(result.percent).toBeNull();
    expect(result.missing[0].owner.department).toBe("Board");
    expect(result.missing[0].message).toMatch(/when the company's money goes out/i);
    /* And the policy itself cannot be approved in that state. */
    const gaps = require("../../services/board/boardPolicy.service").financingGaps(POLICY.financing);
    expect(gaps).toEqual([]);
    expect(require("../../services/board/boardPolicy.service")
      .financingGaps({ ...POLICY.financing, startEvent: undefined }).map((g) => g.field)).toEqual(["startEvent"]);
  });

  test("6 · moving a canonical date changes the fingerprint and stales the costing", async () => {
    const fingerprint = require("../../services/centralCosting/sourceFingerprint.service");
    const lineFor = (dates) => ({
      lines: [{ financingProvenance: financing.freeze({ result: price(SPLIT, dates), policy: POLICY, terms: confirmed({ plan: SPLIT }) }) }],
    });
    const before = fingerprint.fingerprintFor({ assembled: lineFor(DATES) });
    const after = fingerprint.fingerprintFor({
      assembled: lineFor({ ...DATES, DISPATCH: new Date("2026-04-01T00:00:00.000Z") }),
    });

    const frozen = { sourceFingerprint: before.hash, sourceFingerprintParts: before.parts };
    /* Unmoved, it is not stale — a costing must not go stale because the
       clock ticked. */
    expect(fingerprint.compare(frozen, before).stale).toBe(false);
    /* Moved, it is — and the reader is told which fact moved and whose it is. */
    const comparison = fingerprint.compare(frozen, after);
    expect(comparison.stale).toBe(true);
    const changed = comparison.changed.find((c) => c.key.startsWith("financing:due"));
    expect(changed.label).toMatch(/when 40% of this order falls due/i);
    expect(changed.owner).toBe("Packaging & Dispatch");
  });

  test("7 · a record written before plans existed keeps its own methodology", async () => {
    /* Priced from the advance and the credit period, exactly as it always
       was, and it says so. The two methodologies are NOT the same and agree
       only where the old anchor happens to fall on the Board's start. */
    const legacy = financing.compute({
      policy: POLICY,
      terms: confirmed({ advancePercent: 30, creditDays: 73, creditDaysFrom: "INVOICE" }),
      dates: DATES,
    });
    expect(legacy.state).toBe("CALCULATED");
    expect(legacy.working.method).toBe(financing.METHOD.LEGACY_SIMPLE);
    /* 10% x 70% x 73 / 365 = 1.4% — the figure it has always produced, with
       no date in sight. */
    expect(legacy.percent).toBe("1.400000");
    expect(legacy.working.startDate).toBeUndefined();
    /* And it is unaffected by the schedule entirely: no date blocks it. */
    const undated = financing.compute({ policy: POLICY, terms: confirmed({ advancePercent: 30, creditDays: 73, creditDaysFrom: "INVOICE" }), dates: {} });
    expect(undated.percent).toBe("1.400000");
  });

  test("8 · the version freezes the start, every due date, the days and each contribution", async () => {
    const result = price(SPLIT);
    const frozen = financing.freeze({
      result, policy: POLICY, terms: confirmed({ plan: SPLIT }), enquiryRef: "ENQ-1",
    });
    expect(frozen.method).toBe(financing.METHOD.TIMELINE_TRANCHES);
    expect(frozen.startEvent).toBe("MATERIAL_COMMITMENT");
    expect(frozen.startDate.toISOString().slice(0, 10)).toBe("2026-01-01");
    expect(frozen.tranches).toHaveLength(2);
    expect(frozen.tranches[1]).toMatchObject({
      percentage: "40", dueEvent: "DISPATCH", financedDays: "59", effectivePercent: "0.646575",
    });
    expect(frozen.tranches[1].dueDate.toISOString().slice(0, 10)).toBe("2026-03-01");
    expect(frozen.effectivePercent).toBe(result.percent);
    /* By value, so the figure can be checked a year later without re-reading
       an enquiry whose dates will by then have moved. */
    expect(frozen.formula).toMatch(/tranche due date - financing start date/);
  });

  test("the Board still decides whether an advance reduces what is financed", async () => {
    /* `IGNORED`: the whole order is financed for as long as any of it is
       outstanding — 1 January to 1 March, 59 days, on 100% of the order.
       10% x 59 / 365 = 1.616438%. */
    const full = price(SPLIT, DATES, {
      financing: { ...POLICY.financing, advanceTreatment: "IGNORED" },
    });
    expect(full.working.financedSharePercent).toBe("100");
    expect(full.working.longestFinancedDays).toBe("59");
    expect(full.percent).toBe("1.616438");
  });

  test("a draft plan is not priced at all — it is not an agreement yet", async () => {
    const draft = paymentTermsResolution.projectionFor({ paymentTerms: { plan: SPLIT } });
    expect(draft.state).toBe("DRAFT");
    expect(draft.plan).toEqual([]);
    const result = financing.compute({ policy: POLICY, terms: draft, dates: DATES });
    expect(result.state).toBe(financing.STATE.TERMS_MISSING);
    expect(result.percent).toBeNull();
  });
});
