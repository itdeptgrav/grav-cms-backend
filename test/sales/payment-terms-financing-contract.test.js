// test/sales/payment-terms-financing-contract.test.js
//
// THE FINANCE CALCULATION CONTRACT, END TO END.
//
// The Account carries what a customer USUALLY agrees. An Enquiry is offered
// it, may depart from it, and must CONFIRM. Central Costing then works the
// cost of money from that confirmed snapshot and from the Board's policy:
//
//     financing = basis × financed share × annual rate × credit days ÷ day-count basis
//
// These tests fix that chain in place, because the tempting shortcut — reading
// the customer's standing terms live, or reading a duration out of prose —
// silently restates what an order was quoted on months after it was quoted.
//
// They also fix what a payment SCHEDULE of labels and percentages can and
// cannot do. "Advance Payment 60% / Final Payment 40%" carries no timing at
// all, so it can never produce a credit period; the structured terms are the
// only financing input, and this file proves the two do not meet.
"use strict";

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

const express = require("express");
const Account = require("../../models/CMS_Models/Sales/Account");
const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
const financing = require("../../services/centralCosting/financing.service");
const paymentTerms = require("../../services/sales/paymentTermsResolution.service");

const SALES = { id: new mongoose.Types.ObjectId().toString(), name: "Anita Rao", role: "sales" };

/** A complete Board methodology — the half of the formula Sales never touches. */
const POLICY = {
  financing: {
    annualRatePercent: "12",
    basis: "SUBTOTAL_BEFORE_FINANCING",
    advanceTreatment: "REDUCES_FINANCED_AMOUNT",
    dayCountBasis: 365,
  },
};

let server;
let base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/crm/enquiries", require("../../routes/CMS_Routes/Sales/enquiries"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/crm/enquiries`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

let CO;
let seq = 0;
beforeEach(async () => {
  await Promise.all([Enquiry.deleteMany({}), Account.deleteMany({})]);
  const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
  await Acc_Company.deleteMany({});
  CO = await Acc_Company.create({ companyName: "Test Co", booksFromDate: new Date("2026-04-01") });
});

const call = (path, { method = "GET", body } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", "x-test-user": JSON.stringify(SALES) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

async function world(accountTerms = {}) {
  const n = ++seq;
  const account = await Account.create({
    companyId: CO._id, companyName: `Buyer ${n}`, status: "active", ...accountTerms,
  });
  const enquiry = await Enquiry.create({
    enquiryId: `ENQ-PT-${n}`, companyId: CO._id, accountId: account._id,
    journeyId: new mongoose.Types.ObjectId(), title: `Enquiry ${n}`, isActive: true,
  });
  return { account, enquiry };
}

const patchTerms = (enquiry, terms) =>
  call(`/${enquiry._id}`, { method: "PATCH", body: { paymentTerms: terms } });

const reload = (enquiry) => Enquiry.findById(enquiry._id).lean();

/** The financing verdict for an enquiry's stored terms, as costing sees it. */
const verdictFor = (enquiryDoc, policy = POLICY) =>
  financing.compute({ policy, terms: paymentTerms.projectionFor(enquiryDoc) });

/* ══ 1–3. THE ARITHMETIC ══════════════════════════════════════════════════ */

test("60% advance with the balance before dispatch finances 40% for zero days", async () => {
  const { enquiry } = await world();
  const res = await patchTerms(enquiry, {
    shape: "PART_BEFORE_DISPATCH", advancePercent: 60, creditDays: 0, creditDaysFrom: "DISPATCH", confirm: true,
  });
  expect(res.status).toBe(200);

  const v = verdictFor(await reload(enquiry));
  expect(v.working.financedSharePercent).toBe("40");
  expect(v.working.creditDays).toBe(0);
  // Nothing is outstanding over time, so the cost of money on it is nil — a
  // recorded zero, not an absent answer.
  expect(v.percent).toBe("0");
  expect(v.state).toBe("RECORDED_ZERO");
});

test("60% advance with the balance 30 days after invoice finances 40% for 30 days", async () => {
  const { enquiry } = await world();
  const res = await patchTerms(enquiry, {
    shape: "CUSTOM", advancePercent: 60, creditDays: 30, creditDaysFrom: "INVOICE",
    note: "60% with the order, balance 30 days from invoice", confirm: true,
  });
  expect(res.status).toBe(200);

  const v = verdictFor(await reload(enquiry));
  expect(v.working.financedSharePercent).toBe("40");
  expect(v.working.creditDays).toBe(30);
  expect(v.working.creditDaysFrom).toBe("INVOICE");
  // 12% × 0.40 × 30 ÷ 365 = 0.394520…
  expect(v.percent).toBe("0.394521");
  expect(v.working.formula).toBe("basis x financed share x annual rate x credit days / day-count basis");
});

test("the two agreements cost different amounts, which is the point", async () => {
  const { enquiry: a } = await world();
  const { enquiry: b } = await world();
  await patchTerms(a, {
    shape: "PART_BEFORE_DISPATCH", advancePercent: 60, creditDays: 0, creditDaysFrom: "DISPATCH", confirm: true,
  });
  await patchTerms(b, {
    shape: "CUSTOM", advancePercent: 60, creditDays: 30, creditDaysFrom: "INVOICE", note: "30 days", confirm: true,
  });

  const before = verdictFor(await reload(a));
  const after = verdictFor(await reload(b));
  expect(before.percent).toBe("0");
  expect(Number(after.percent)).toBeGreaterThan(0);
  // Same 60/40 split. A label-and-percentage schedule cannot tell these apart;
  // that is exactly why it cannot be a financing input.
  expect(before.working.financedSharePercent).toBe(after.working.financedSharePercent);
});

test("the day-count basis and the advance treatment are the Board's, not Sales'", async () => {
  const { enquiry } = await world();
  await patchTerms(enquiry, {
    shape: "CREDIT_INVOICE", advancePercent: 0, creditDays: 60, creditDaysFrom: "INVOICE", confirm: true,
  });
  const doc = await reload(enquiry);

  const on365 = verdictFor(doc);
  const on360 = verdictFor(doc, { financing: { ...POLICY.financing, dayCountBasis: 360 } });
  expect(on365.percent).not.toBe(on360.percent);

  // And an advance only reduces the financed amount when the Board says so.
  await patchTerms(enquiry, {
    shape: "CUSTOM", advancePercent: 50, creditDays: 60, creditDaysFrom: "INVOICE", note: "half up front", confirm: true,
  });
  const half = await reload(enquiry);
  expect(verdictFor(half).working.financedSharePercent).toBe("50");
  expect(
    verdictFor(half, { financing: { ...POLICY.financing, advanceTreatment: "IGNORED" } }).working.financedSharePercent,
  ).toBe("100");
});

/* ══ 4. PROSE NEVER DRIVES THE CALCULATION ════════════════════════════════ */

test("free-text wording is carried for people and never read as a figure", async () => {
  const { enquiry } = await world();
  // The prose says 90 days. The structured answer says 30. The figure wins,
  // and the prose is not parsed at all.
  await patchTerms(enquiry, {
    shape: "CUSTOM", advancePercent: 0, creditDays: 30, creditDaysFrom: "INVOICE",
    note: "NET90 — ninety days from invoice, 90 days credit", confirm: true,
  });
  const v = verdictFor(await reload(enquiry));
  expect(v.working.creditDays).toBe(30);
  expect(JSON.stringify(v.working)).not.toMatch(/ninety|NET90/i);
});

test("an account's prose alone is not an answer for any enquiry", async () => {
  const { enquiry } = await world({
    paymentTermsCode: "NET45",
    negotiatedTerms: "45 days from bill of lading, 20% advance",
  });
  // Nothing was confirmed on the enquiry, so there is no duration to finance —
  // the words on the account do not become one.
  const v = verdictFor(await reload(enquiry));
  expect(v.percent).toBeNull();
  expect(v.missing.map((m) => m.code)).toContain("PAYMENT_TERMS_MISSING");
});

/* ══ 5–7. THE ACCOUNT IS A DEFAULT, COPIED — NEVER A LIVE LINK ════════════ */

test("account defaults are offered as a suggestion and written nowhere until confirmed", async () => {
  const { account, enquiry } = await world({
    paymentTermsShape: "CREDIT_INVOICE", advancePercent: 0, creditDays: 45, creditDaysFrom: "INVOICE",
  });

  const offer = await call(`/${enquiry._id}/commercial-defaults`);
  expect(offer.status).toBe(200);
  expect(offer.body.payment.available).toBe(true);
  expect(offer.body.payment.creditDays).toBe(45);
  expect(offer.body.payment.shape).toBe("CREDIT_INVOICE");

  // Reading the offer changed nothing on the enquiry.
  const untouched = await reload(enquiry);
  expect(untouched.paymentTerms?.creditDays).toBeUndefined();
  expect(untouched.paymentTerms?.confirmedAt).toBeUndefined();
  expect(verdictFor(untouched).percent).toBeNull();

  // Accepting them copies the figures onto the enquiry.
  await patchTerms(enquiry, {
    shape: "CREDIT_INVOICE", advancePercent: 0, creditDays: 45, creditDaysFrom: "INVOICE", confirm: true,
  });
  const confirmed = await reload(enquiry);
  expect(confirmed.paymentTerms.creditDays).toBe(45);
  expect(confirmed.paymentTerms.source).toBe("ACCOUNT");
  expect(confirmed.paymentTerms.confirmedAt).toBeTruthy();
  expect(String(account._id)).toBeTruthy();
});

test("an order-specific override does not touch the account", async () => {
  const { account, enquiry } = await world({
    paymentTermsShape: "CREDIT_INVOICE", advancePercent: 0, creditDays: 45, creditDaysFrom: "INVOICE",
  });
  await patchTerms(enquiry, {
    shape: "CREDIT_INVOICE", advancePercent: 0, creditDays: 15, creditDaysFrom: "INVOICE", confirm: true,
  });

  const after = await Account.findById(account._id).lean();
  expect(after.creditDays).toBe(45);
  expect(after.paymentTermsShape).toBe("CREDIT_INVOICE");

  const e = await reload(enquiry);
  expect(e.paymentTerms.creditDays).toBe(15);
  // The departure is recorded as a difference, against what the account said
  // at the moment of confirmation.
  expect(e.paymentTerms.source).toBe("ENQUIRY");
  expect(e.paymentTerms.accountDefaultAtConfirmation.creditDays).toBe(45);
});

test("changing the account later does not rewrite a confirmed enquiry", async () => {
  const { account, enquiry } = await world({
    paymentTermsShape: "CREDIT_INVOICE", advancePercent: 0, creditDays: 30, creditDaysFrom: "INVOICE",
  });
  await patchTerms(enquiry, {
    shape: "CREDIT_INVOICE", advancePercent: 0, creditDays: 30, creditDaysFrom: "INVOICE", confirm: true,
  });
  const quotedOn = verdictFor(await reload(enquiry)).percent;

  // The customer renegotiates months later.
  await Account.updateOne({ _id: account._id }, { $set: { creditDays: 120 } });

  const still = await reload(enquiry);
  expect(still.paymentTerms.creditDays).toBe(30);
  expect(verdictFor(still).percent).toBe(quotedOn);
  expect(still.paymentTerms.accountDefaultAtConfirmation.creditDays).toBe(30);
});

/* ══ 8. MISSING TIMING BLOCKS CONFIRMATION — IT NEVER BECOMES ZERO ════════ */

test("a credit period with no starting event cannot be confirmed", async () => {
  const { enquiry } = await world();
  const res = await patchTerms(enquiry, {
    shape: "CUSTOM", advancePercent: 40, creditDays: 30, creditDaysFrom: "", confirm: true,
  });
  expect(res.status).toBe(400);

  const e = await reload(enquiry);
  expect(e.paymentTerms?.confirmedAt).toBeUndefined();
  // And costing reports it as unanswered rather than as an order that costs
  // nothing to finance.
  const v = verdictFor(e);
  expect(v.percent).toBeNull();
  expect(v.missing.map((m) => m.code)).toContain("PAYMENT_TERMS_MISSING");
});

test("terms recorded but never confirmed are unanswered, not zero", async () => {
  const { enquiry } = await world();
  await patchTerms(enquiry, {
    shape: "CREDIT_INVOICE", advancePercent: 0, creditDays: 30, creditDaysFrom: "INVOICE",
  });
  const e = await reload(enquiry);
  expect(e.paymentTerms.creditDays).toBe(30);
  expect(e.paymentTerms.confirmedAt).toBeUndefined();

  const v = verdictFor(e);
  expect(v.percent).toBeNull();
  expect(v.state).toBe("TERMS_MISSING");
});

test("editing confirmed terms re-opens them instead of keeping the old confirmation", async () => {
  const { enquiry } = await world();
  await patchTerms(enquiry, {
    shape: "CREDIT_INVOICE", advancePercent: 0, creditDays: 30, creditDaysFrom: "INVOICE", confirm: true,
  });
  await patchTerms(enquiry, {
    shape: "CREDIT_INVOICE", advancePercent: 0, creditDays: 90, creditDaysFrom: "INVOICE",
  });

  const e = await reload(enquiry);
  expect(e.paymentTerms.creditDays).toBe(90);
  expect(e.paymentTerms.confirmedAt).toBeFalsy();
  expect(verdictFor(e).percent).toBeNull();
});

/* ══ 9. OLD ACCOUNTS DERIVE SAFELY, WITHOUT MIGRATION ═════════════════════ */

test("an account recorded before shapes existed still offers a usable suggestion", async () => {
  // Figures only — no paymentTermsShape, as every account had before the
  // vocabulary existed.
  const { enquiry } = await world({ advancePercent: 40, creditDays: 30, creditDaysFrom: "INVOICE" });
  const offer = await call(`/${enquiry._id}/commercial-defaults`);

  expect(offer.body.payment.available).toBe(true);
  expect(offer.body.payment.advancePercent).toBe(40);
  expect(offer.body.payment.creditDays).toBe(30);
  // A part advance that also runs a credit period has no short name, so it
  // derives as CUSTOM rather than as a shape that flatters it.
  expect(offer.body.payment.shape).toBe("CUSTOM");
});

test("an account with nothing recorded offers nothing, and invents no zero", async () => {
  const { enquiry } = await world();
  const offer = await call(`/${enquiry._id}/commercial-defaults`);
  expect(offer.body.payment.available).toBe(false);
  expect(offer.body.payment.advancePercent).toBeNull();
  expect(offer.body.payment.creditDays).toBeNull();
});

test("a 100% advance is a complete answer with no credit period", async () => {
  const { enquiry } = await world();
  const res = await patchTerms(enquiry, {
    shape: "FULL_ADVANCE", advancePercent: 100, creditDays: 0, confirm: true,
  });
  expect(res.status).toBe(200);

  const v = verdictFor(await reload(enquiry));
  expect(v.working.financedSharePercent).toBe("0");
  expect(v.percent).toBe("0");
  expect(v.state).toBe("RECORDED_ZERO");
});

/* ══ THE SCHEDULE ROWS ARE NOT IN THIS CHAIN ══════════════════════════════ */

test("a label-and-percentage schedule is not an input to financing", () => {
  /* The document rows, exactly as a proforma carries them, handed in every
     shape the chain could conceivably look for them. They carry no timing, so
     none of them can produce a credit period — the verdict is "nobody said
     when this gets paid", not a duration of zero. */
  const rows = [
    { name: "Advance Payment", percentage: 60 },
    { name: "Final Payment", percentage: 40 },
  ];
  for (const doc of [
    { paymentTerms: { schedule: rows } },
    { paymentTerms: { paymentSchedule: rows } },
    { paymentSchedule: rows, paymentTerms: {} },
  ]) {
    const v = financing.compute({ policy: POLICY, terms: paymentTerms.projectionFor(doc) });
    expect(v.percent).toBeNull();
    expect(v.missing.map((m) => m.code)).toContain("PAYMENT_TERMS_MISSING");
  }

  // And the projection a costing reads exposes only the structured answer.
  const projection = paymentTerms.projectionFor({
    paymentTerms: { advancePercent: 60, creditDays: 30, creditDaysFrom: "INVOICE", confirmedAt: new Date() },
  });
  expect(Object.keys(projection)).not.toContain("schedule");
  expect(Object.keys(projection)).not.toContain("paymentSchedule");
  expect(projection.creditDays).toBe(30);
});
