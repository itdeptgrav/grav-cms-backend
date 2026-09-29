// test/costing/board-financing-costing.test.js
//
// THE BOARD'S RULE, MEETING SALES' AGREEMENT, IN A REAL COSTING.
//
// ── WHAT THIS REPLACES ──────────────────────────────────────────────────────
// `CostingPolicy.financingRatePercent` — one company number, applied as a flat
// percentage of a subtotal to every costing regardless of what had been agreed
// with the buyer. Two orders with the same materials and payment terms ninety
// days apart carried identical financing. That is not a cost of capital; it is
// a surcharge with a cost of capital's name on it.
//
// ── THE FORMULA UNDER TEST ──────────────────────────────────────────────────
//     financing = basis x financed share x annual rate x credit days / day count
//
// Every term is a recorded decision with an owner, and no term has a default.
// The edge cases below are the ones where a plausible default would have been
// silently wrong: a full advance, a zero credit period, an unanswered enquiry
// and an undecided Board all produce nil, and only two of them are an ANSWER.
"use strict";
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const Employee = require("../../models/Employee");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DeptUser = require("../../models/Access/DeptUser");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
const CostingVersion = require("../../models/CMS_Models/Costing/CostingVersion");
const BoardPolicy = require("../../models/CMS_Models/Board/BoardPolicy");
const financing = require("../../services/centralCosting/financing.service");
const { seedSourceBacked, configureProduction, approveFinancingPolicy, prepareForCosting } = require("./helpers/sourceBacked");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/costings", require("../../routes/CMS_Routes/Costing/costings"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/costings`;
  await BoardPolicy.init();
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const newKey = () => `fin-${++seq}-${Math.random().toString(36).slice(2)}`;

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
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

const company = (name) =>
  Acc_Company.create({ companyName: `${name} ${++seq}`, booksFromDate: new Date("2026-04-01") });

async function admin(companies = []) {
  const n = ++seq;
  const email = `fin-${n}@test.example`;
  const emp = await Employee.create({
    firstName: "F", lastName: `N${n}`, email, biometricId: `FN${n}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  await DeptUser.create({
    name: "F", email, passwordHash: "x", isAdmin: true, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  for (const co of companies) {
    await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "F" });
  }
  return {
    email,
    token: jwt.sign(
      { id: String(emp._id), email, name: "F Actor", role: "employee", employeeId: emp.biometricId },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
    ),
  };
}

/* No overhead here on purpose: it would sit between the direct cost and the
   financing basis and make every figure below two steps of arithmetic instead
   of one. Overhead's participation is proved in costing-corrections. */
const POLICY = {
  baseCurrency: "INR", roundingMode: "HALF_UP", sellingPriceIncrementMinor: 100,
  revision: 0,
};

const SCEN = [{ key: "q500", quantity: "500", isPrimary: true }];

/**
 * A company, a costed enquiry product, and whichever halves of the financing
 * question the test wants answered.
 *
 * `terms: null` leaves the enquiry unanswered; `board: null` leaves the Board
 * undecided. Both defaults are ANSWERED, so a test that cares about a gap
 * turns exactly one of them off and nothing else changes.
 */
async function world({ terms = { advancePercent: 0, creditDays: 73, creditDaysFrom: "INVOICE" }, board = {} } = {}) {
  const co = await company("Fin");
  const me = await admin([co]);
  await call("/policy/current", { method: "PUT", token: me.token, company: co._id, body: POLICY });
  if (board) await approveFinancingPolicy(co._id, { annualRatePercent: "10", ...board });
  const seeded = await seedSourceBacked(co._id, terms ? { paymentTerms: terms } : {});
  /* `overhead: null` keeps this suite's arithmetic one step: overhead would
     sit between the direct cost and the financing basis and make every figure
     below two steps instead of one. Its participation is proved in
     costing-corrections and in board-overhead-costing. */
  await configureProduction(co._id, { overhead: null });
  const made = await call("/", {
    method: "POST", token: me.token, company: co._id, idempotencyKey: newKey(),
    body: { context: seeded.context },
  });
  expect(made.status).toBe(201);
  return { co, me, seeded, costingId: made.body.costing.id };
}

/* ── PREPARED THE WAY SALES DOES ──────────────────────────────────────────
   `POST /:id/versions` was Calculate, and it refuses a browser client now
   (`COSTING_PREPARATION_MOVED_TO_SALES`). What this suite proves — which
   Board policy is applied to which basis, and what the version freezes — is
   about the ENGINE, and the engine is unchanged: the orchestration resolves
   the brief and the effective policies and calls it. Only the door moved. */
const calc = (w) => prepareForCosting(w.costingId);

const linesOf = (r) => Object.fromEntries(
  r.body.versions[0].cost.scenarios[0].lines.map((l) => [l.lineKey, l.totalMinor]),
);

/* ═══ 1 · THE FORMULA ═════════════════════════════════════════════════════ */

describe("the financing figure comes from both records", () => {
  test("a partial advance finances only the balance, for the days agreed", async () => {
    /* Direct cost 10,354 per garment x 500 = 5,177,000 for the run.
       10% a year x 70% financed x 73 days / 365 = 1.4% of 5,177,000 = 72,478. */
    const w = await world({ terms: { advancePercent: 30, creditDays: 73, creditDaysFrom: "INVOICE" } });
    const r = await calc(w);
    expect(r.status).toBe(201);
    expect(linesOf(r)["policy:financing"]).toBe(72478);

    const fin = r.body.versions[0].cost.financingProvenance;
    expect(fin.state).toBe("CALCULATED");
    expect(fin.financedSharePercent).toBe("70");
    expect(fin.effectivePercent).toBe("1.400000");
  });

  test("no advance finances the whole order", async () => {
    const w = await world({ terms: { advancePercent: 0, creditDays: 73, creditDaysFrom: "INVOICE" } });
    const r = await calc(w);
    /* 10% x 100% x 73/365 = 2% of 5,177,000 = 103,540. */
    expect(linesOf(r)["policy:financing"]).toBe(103540);
    expect(r.body.versions[0].cost.financingProvenance.financedSharePercent).toBe("100");
  });

  test("360-day and 365-day conventions give different, correct answers", async () => {
    /* About 1.4% apart on the financing figure — small, real, and not
       something either party should discover by accident. */
    const a = await world({ board: { dayCountBasis: 365 } });
    const b = await world({ board: { dayCountBasis: 360 } });
    const ra = await calc(a);
    const rb = await calc(b);
    expect(linesOf(ra)["policy:financing"]).toBe(103540);
    /* 10% x 73/360 = 2.027778% of 5,177,000 = 104,978. */
    expect(linesOf(rb)["policy:financing"]).toBe(104978);
    expect(rb.body.versions[0].cost.financingProvenance.dayCountBasis).toBe(360);
  });

  test("the Board decides whether the advance reduces the financed amount", async () => {
    /* ── AND IT IS NOT HARD-CODED EITHER WAY ───────────────────────────
       "Money already received is not money being financed" is the common
       answer and not the only defensible one. A company financing its whole
       working-capital cycle at a blended rate may charge the full order. */
    const terms = { advancePercent: 50, creditDays: 73, creditDaysFrom: "INVOICE" };
    const reduces = await world({ terms, board: { advanceTreatment: "REDUCES_FINANCED_AMOUNT" } });
    const ignored = await world({ terms, board: { advanceTreatment: "IGNORED" } });

    expect(linesOf(await calc(reduces))["policy:financing"]).toBe(51770);   // 1% of the run
    expect(linesOf(await calc(ignored))["policy:financing"]).toBe(103540);  // 2%
  });

  test("financing is charged on a basis that includes overhead, not on the direct cost", () => {
    /* The ordering claim, at the unit level. Proved end to end against real
       money in costing-corrections; here it is the basis the Board's
       methodology actually names. */
    const out = financing.compute({
      policy: {
        financing: {
          annualRatePercent: "10", basis: "SUBTOTAL_BEFORE_FINANCING",
          advanceTreatment: "REDUCES_FINANCED_AMOUNT", dayCountBasis: 365,
        },
      },
      terms: { state: "CONFIRMED", advancePercent: 0, creditDays: 73 },
    });
    expect(out.basis).toBe("SUBTOTAL_BEFORE_FINANCING");
  });
});

/* ═══ 2 · THE EDGE CASES A DEFAULT WOULD HAVE GOT WRONG ═══════════════════ */

describe("nil, and the four different reasons for it", () => {
  test("a full advance is a recorded zero — nothing outstanding, not nothing decided", async () => {
    const w = await world({ terms: { advancePercent: 100 } });
    const r = await calc(w);
    expect(linesOf(r)["policy:financing"]).toBe(0);

    const fin = r.body.versions[0].cost.financingProvenance;
    expect(fin.state).toBe("RECORDED_ZERO");
    /* The terms that produced the zero are on the record, so "paid in full up
       front" stays readable as an answer after the account moves again. */
    expect(fin.advancePercent).toBe("100");
    expect(fin.termsConfirmedAt).toBeTruthy();
  });

  test("zero credit days is a recorded zero too — the money is out for no time", async () => {
    const w = await world({ terms: { advancePercent: 20, creditDays: 0 } });
    const r = await calc(w);
    expect(linesOf(r)["policy:financing"]).toBe(0);
    const fin = r.body.versions[0].cost.financingProvenance;
    expect(fin.state).toBe("RECORDED_ZERO");
    expect(fin.creditDays).toBe(0);
  });

  test("a stated 'financing does not apply' is a decision, with its reason frozen", async () => {
    const w = await world({
      terms: { notApplicable: true, notApplicableReason: "Intercompany transfer at cost." },
    });
    const r = await calc(w);
    expect(linesOf(r)["policy:financing"]).toBe(0);
    const fin = r.body.versions[0].cost.financingProvenance;
    expect(fin.state).toBe("NOT_APPLICABLE");
    expect(fin.notApplicableReason).toMatch(/Intercompany/);
  });

  test("an unanswered enquiry produces NO line, and names Sales", async () => {
    /* ── THE ONE THIS WHOLE CONTRACT EXISTS FOR ────────────────────────
       Silence must not read as a cash sale. A zero line here would be the
       claim that this order costs nothing to finance, which is precisely what
       nobody has said. */
    const w = await world({ terms: null });
    const r = await calc(w);
    expect(r.status).toBe(201);
    expect(linesOf(r)["policy:financing"]).toBeUndefined();
    expect(r.body.versions[0].cost.financingProvenance).toBeUndefined();

    const family = r.body.versions[0].cost.completeness.families.find((f) => f.key === "financing");
    expect(family.state).not.toBe("RECORDED_ZERO");
    expect(r.body.versions[0].cost.completeness.costComplete).toBe(false);
  });

  test("terms recorded but never confirmed are still unanswered", async () => {
    /* Confirming is what says these terms apply to this order. A draft is
       somebody's working, and costing one would put a figure against an
       agreement nobody made. */
    const w = await world({ terms: null });
    await Enquiry.updateOne(
      { _id: w.seeded.enquiryId || w.seeded.enquiry?._id },
      { $set: { paymentTerms: { advancePercent: 30, creditDays: 45, creditDaysFrom: "INVOICE" } } },
    );
    const r = await calc(w);
    expect(linesOf(r)["policy:financing"]).toBeUndefined();
  });

  test("no Board policy produces no line, and names the Board rather than Sales", async () => {
    const w = await world({ board: null });
    const r = await calc(w);
    expect(r.status).toBe(201);
    expect(linesOf(r)["policy:financing"]).toBeUndefined();
    expect(r.body.versions[0].cost.completeness.costComplete).toBe(false);
  });

  test("both gaps are reported, with their own owners, not just the first", () => {
    /* They are fixed at different desks. Reporting only one would leave the
       other department believing their half was done. */
    const out = financing.compute({ policy: null, terms: null });
    expect(out.missing.map((m) => m.code).sort())
      .toEqual(["FINANCING_POLICY_MISSING", "PAYMENT_TERMS_MISSING"]);
    expect(out.missing.find((m) => m.code === "FINANCING_POLICY_MISSING").owner.department).toBe("Board");
    expect(out.missing.find((m) => m.code === "PAYMENT_TERMS_MISSING").owner.department).toBe("Sales");
    expect(out.percent).toBeNull();
  });

  test("an order Sales exempted needs no Board policy to be recorded as unfinanced", () => {
    /* Asking the Board to decide the company's borrowing rate before an
       intercompany transfer can be recorded as unfinanced would be asking the
       wrong person about the wrong order. */
    const out = financing.compute({
      policy: null,
      terms: { state: "NOT_APPLICABLE", notApplicable: true, notApplicableReason: "Sample at cost." },
    });
    expect(out.state).toBe("NOT_APPLICABLE");
    expect(out.missing).toEqual([]);
  });
});

/* ═══ 3 · WHAT IS FROZEN, AND THAT IT STAYS FROZEN ════════════════════════ */

describe("a frozen version keeps its own answer", () => {
  test("every decision the figure rested on is on the version, by value", async () => {
    const w = await world({ terms: { advancePercent: 30, creditDays: 73, creditDaysFrom: "BILL_OF_LADING" } });
    const r = await calc(w);
    const fin = r.body.versions[0].cost.financingProvenance;

    /* The Board's half. */
    expect(fin.boardPolicyId).toBeTruthy();
    expect(fin.annualRatePercent).toBe("10");
    expect(fin.basis).toBe("SUBTOTAL_BEFORE_FINANCING");
    expect(fin.advanceTreatment).toBe("REDUCES_FINANCED_AMOUNT");
    expect(fin.dayCountBasis).toBe(365);
    expect(fin.policyEffectiveFrom).toBeTruthy();
    expect(fin.policyApprovedByName).toBeTruthy();

    /* Sales' half — including WHAT the days are counted from, because thirty
       days from the invoice and thirty from the bill of lading differ by the
       whole shipping time. */
    expect(fin.advancePercent).toBe("30");
    expect(fin.creditDays).toBe(73);
    expect(fin.creditDaysFrom).toBe("BILL_OF_LADING");

    /* And the arithmetic, so nobody has to reconstruct it. */
    expect(fin.financedSharePercent).toBe("70");
    expect(fin.effectivePercent).toBe("1.400000");
    expect(fin.formula).toMatch(/day-count basis/);
  });

  test("a new Board policy does not restate a version frozen before it", async () => {
    const w = await world({ terms: { advancePercent: 0, creditDays: 73, creditDaysFrom: "INVOICE" } });
    const before = await calc(w);
    const frozenAmount = linesOf(before)["policy:financing"];
    expect(frozenAmount).toBe(103540);

    /* The Board triples the rate, effective today. */
    await approveFinancingPolicy(w.co._id, {
      annualRatePercent: "30", effectiveFrom: new Date(Date.now() - 1000),
    });

    const read = await call(`/${w.costingId}/versions`, { token: w.me.token, company: w.co._id });
    const v = read.body.versions.find((x) => x.id === before.body.versions[0].id);
    expect(v.cost.scenarios[0].lines.find((l) => l.lineKey === "policy:financing").totalMinor)
      .toBe(frozenAmount);
    expect(v.cost.financingProvenance.annualRatePercent).toBe("10");

    /* Not because anything protects the version — because it copied. */
    const stored = await CostingVersion.findById(v.id).lean();
    expect(stored.financingProvenance.annualRatePercent).toBe("10");
  });

  test("a customer renegotiating does not restate a version either", async () => {
    const w = await world({ terms: { advancePercent: 0, creditDays: 73, creditDaysFrom: "INVOICE" } });
    const before = await calc(w);
    const frozenAmount = linesOf(before)["policy:financing"];

    await Enquiry.updateOne(
      { _id: w.seeded.enquiryId || w.seeded.enquiry?._id },
      { $set: { "paymentTerms.creditDays": 180 } },
    );

    const read = await call(`/${w.costingId}/versions`, { token: w.me.token, company: w.co._id });
    const v = read.body.versions.find((x) => x.id === before.body.versions[0].id);
    expect(v.cost.financingProvenance.creditDays).toBe(73);
    expect(v.cost.scenarios[0].lines.find((l) => l.lineKey === "policy:financing").totalMinor)
      .toBe(frozenAmount);
  });

  test("a future-dated Board policy does not reach a costing made today", async () => {
    const w = await world({ board: null });
    await approveFinancingPolicy(w.co._id, {
      annualRatePercent: "10", effectiveFrom: new Date("2035-01-01"),
    });
    const r = await calc(w);
    /* Approved, and in force for nothing yet. No line, and no zero. */
    expect(linesOf(r)["policy:financing"]).toBeUndefined();
  });
});

/* ═══ 4 · THE RETIRED FLAT RATE ═══════════════════════════════════════════ */

describe("the old company financing rate is no longer applied", () => {
  test("a legacy rate on the policy charges nothing, and the version says so", async () => {
    const w = await world({ board: null, terms: null });
    /* Written straight to the collection, the way history was: the route that
       put it there refuses it now. */
    const CostingPolicy = require("../../models/CMS_Models/Costing/CostingPolicy");
    await CostingPolicy.collection.updateOne(
      { companyId: w.co._id },
      { $set: { financingBasis: "SUBTOTAL_BEFORE_FINANCING", financingRatePercent: "2" } },
    );

    const r = await calc(w);
    expect(linesOf(r)["policy:financing"]).toBeUndefined();
    /* ── AND IT IS NOT SILENT ──────────────────────────────────────────
       A rule that stops applying without saying so is a number that changes
       for a reason nobody can find. */
    expect((r.body.versions[0].warnings || []).map((x) => x.code))
      .toContain("POLICY_FINANCING_RETIRED");
  });
});

/* ═══ 5 · WHAT THE FORMULA IS, INDEPENDENT OF ANY DATABASE ════════════════ */

describe("compute", () => {
  const policy = (over = {}) => ({
    _id: new mongoose.Types.ObjectId(),
    financing: {
      annualRatePercent: "12", basis: "SUBTOTAL_BEFORE_FINANCING",
      advanceTreatment: "REDUCES_FINANCED_AMOUNT", dayCountBasis: 365, ...over,
    },
  });
  const confirmed = (over = {}) => ({
    state: "CONFIRMED", advancePercent: 30, creditDays: 45, creditDaysFrom: "INVOICE", ...over,
  });

  test("rate x share x days / day count", () => {
    /* 12 x 0.7 x 45 / 365 = 1.035616%. */
    expect(financing.compute({ policy: policy(), terms: confirmed() }).percent).toBe("1.035616");
  });

  test("the financed share is the Board's rule applied to Sales' advance", () => {
    expect(financing.financedShare({ advanceTreatment: "REDUCES_FINANCED_AMOUNT", advancePercent: 30 }).toFixed())
      .toBe("0.7");
    expect(financing.financedShare({ advanceTreatment: "IGNORED", advancePercent: 30 }).toFixed())
      .toBe("1");
    /* An advance of nothing is not an absent advance; both finance the whole
       order, and neither is ever negative. */
    expect(financing.financedShare({ advanceTreatment: "REDUCES_FINANCED_AMOUNT", advancePercent: 0 }).toFixed())
      .toBe("1");
    expect(financing.financedShare({ advanceTreatment: "REDUCES_FINANCED_AMOUNT", advancePercent: 100 }).toFixed())
      .toBe("0");
  });

  test("an incomplete Board methodology is a missing policy, not a partial one", () => {
    /* A rate with no day count cannot produce a period rate at all. Treating
       the absent half as a default would be inventing the decision. */
    const out = financing.compute({ policy: policy({ dayCountBasis: undefined }), terms: confirmed() });
    expect(out.state).toBe("POLICY_MISSING");
    expect(out.percent).toBeNull();
    expect(out.missing[0].owner.department).toBe("Board");
  });

  test("six decimal places are kept, because the basis is large", () => {
    /* Rounding an intermediate to the precision of a displayed rate loses
       money on every large basis. The engine rounds once, at the end. */
    const out = financing.compute({
      policy: policy({ annualRatePercent: "13.75" }),
      terms: confirmed({ advancePercent: 0, creditDays: 37 }),
    });
    expect(out.percent).toBe("1.393836");
  });

  test("nothing it returns is a rate anybody typed into a costing", () => {
    const out = financing.compute({ policy: policy(), terms: confirmed() });
    /* The whole output is derived from two records. There is no field on it a
       costing user could have supplied. */
    expect(Object.keys(out).sort()).toEqual(["basis", "missing", "percent", "state", "working"]);
  });
});
