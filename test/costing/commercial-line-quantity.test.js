// test/costing/commercial-line-quantity.test.js
//
// THE QUANTITY A GARMENT IS PRICED FOR, CONFIRMED ONCE, BY SALES.
//
// ── THE DEFECT UNDER TEST ───────────────────────────────────────────────────
// The number Central Costing calculated against had no owner. It could be read
// from the buyer's asked-for quantity on `products[]`, or from a quantity typed
// into a "Costing Brief" that Sales had to understand and operate — and the two
// could disagree, so a floor price could be calculated for a quantity nobody
// had settled on.
//
// One line, one quantity, one owner. What is proved here is that confirming it
// drives the existing costing authority rather than becoming a second one, that
// a change makes the previous calculation stale instead of being edited into
// it, and that history survives.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

/* ── THE ROUTER PULLS IN THE WHOLE APPLICATION'S EDGES ────────────────────
   Push, notifications, change logging and the CoWork sheets are not part of
   any rule under test here, and one of them refuses to load without a
   Firebase service account. Stubbed exactly as the commercial-review suite
   stubs them, so what runs is the route's own logic. */
jest.mock("../../config/firebaseAdmin", () => ({ messaging: () => ({ send: async () => ({}) }) }));
jest.mock("../../services/NotificationService", () => ({
  notify: async () => ({}), notifyUser: async () => ({}), send: async () => ({}),
}));
jest.mock("../../services/departmentNotify.service", () => ({
  notifyEvent: async () => ({}), APP_URL: "http://localhost",
}));
jest.mock("../../services/changeLog", () => ({
  recordChange: async () => ({}), historyFor: async () => [], diff: () => ({}),
}));
jest.mock("../../services/cowork.service", () => ({}), { virtual: true });
jest.mock("../../services/coworkSheets.service", () => ({}), { virtual: true });
jest.mock("../../Middlewear/SalesAuthMiddlewear", () => {
  const mw = (req, res, next) => {
    if (!global.__ACTOR__) return res.status(401).json({ success: false });
    req.user = global.__ACTOR__;
    next();
  };
  mw.withRoles = () => mw;
  return mw;
});

const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

/* Source assertions read intent, not commentary: a rule named only in a
   comment is not a rule. */
const bare = (t) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

let rs;
beforeAll(async () => {
  await mongoose.disconnect();
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(rs.getUri(), { dbName: "commercial_line" });
}, 300000);
afterAll(async () => {
  await mongoose.disconnect();
  if (rs) await rs.stop();
}, 300000);

const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");
const Account = require("../../models/CMS_Models/Sales/Account");
const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");

const commercialLine = require("../../services/sales/commercialLine.service");
const costingBrief = require("../../services/sales/costingBrief.service");

let seq = 0;
/* A real id: the brief stamps `createdBy.id` as an ObjectId, and a fixture
   that sent a string would fail on the record rather than on the rule. */
const actor = { id: String(new mongoose.Types.ObjectId()), name: "A Salesperson" };
const refusalOf = async (fn) => { try { await fn(); } catch (e) { return e; } return null; };

/** An enquiry with one product line and an approved style to quote. */
async function world() {
  const n = ++seq;
  const co = await Acc_Company.create({
    companyName: `CL ${n}`, booksFromDate: new Date("2026-04-01"),
  });
  const account = await Account.create({ companyId: co._id, companyName: `Buyer ${n}`, status: "active" });
  const journey = await SalesJourney.create({
    journeyId: `SJ-CL-${n}`, companyId: co._id, name: `J${n}`,
    accountId: account._id, ownerId: new mongoose.Types.ObjectId(), ownerName: "O",
  });
  const enquiry = await Enquiry.create({
    enquiryId: `ENQ-CL-${n}`, journeyId: journey._id, accountId: account._id,
    companyId: co._id, title: `Enquiry ${n}`, isActive: true,
    products: [{ product: `CL${n} polo`, quantity: 250 }],
  });
  const saved = await Enquiry.findById(enquiry._id).lean();
  const productLineRef = String(saved.products[0].productLineRef);

  const style = await SampleStyle.create({
    sampleStyleId: `SS-CL-${n}`, styleCode: `SC-CL-${n}`, companyId: co._id,
    productName: `CL${n} polo`, journeyId: journey._id, enquiryId: enquiry._id,
    stage: "rnd", materials: { status: "selected", rawItems: [] },
    techSheet: {
      status: "approved",
      technical: { status: "approved", revision: 1 },
      technicalRevisions: [{
        revision: 1, outcome: "approved",
        submittedAt: new Date("2026-07-01"), submittedBy: { name: "R&D" },
        decidedAt: new Date("2026-07-02"), decidedByName: "Sales",
        snapshot: { materials: [] },
      }],
    },
  });

  return { co, enquiry, style, productLineRef, ctx: { companyId: co._id } };
}

const confirm = (w, quantity, over = {}) => commercialLine.confirmQuantity(w.ctx, {
  enquiryId: String(w.enquiry._id),
  productLineRef: w.productLineRef,
  sampleStyleId: String(w.style._id),
  quantity,
  actor,
  ...over,
});

/* ═══ 1 · THE LINE ═══════════════════════════════════════════════════════ */

describe("the commercial line", () => {
  test("confirming a quantity creates one line, keyed by what cannot move", async () => {
    const w = await world();
    const out = await confirm(w, 500);

    expect(out.changed).toBe(true);
    expect(out.line.quantity).toBe(500);
    expect(out.line.revision).toBe(1);
    expect(out.line.productLineRef).toBe(w.productLineRef);
    expect(out.line.sampleStyleId).toBe(String(w.style._id));
    expect(out.line.confirmedByName).toBe("A Salesperson");

    /* ── AND NEVER BY THE PRODUCT'S NAME ──────────────────────────────
       The name is carried as a display snapshot; the key is the permanent
       reference and the style. */
    const stored = await Enquiry.findById(w.enquiry._id).lean();
    expect(stored.commercialLines).toHaveLength(1);
    expect(stored.commercialLines[0].productLineRef).toBe(w.productLineRef);
    expect(String(stored.commercialLines[0].sampleStyleId)).toBe(String(w.style._id));
  });

  test("it needs no portal customer and carries no selling price", async () => {
    /* A prospect's order is priced before anybody is linked, and the price is
       Sales' decision after they see the floor. */
    const w = await world();
    const out = await confirm(w, 500);
    expect(out.line.quantity).toBe(500);

    /* ── NO MONEY AND NO BUYER ON THE LINE ────────────────────────────
       `costing` is present and carries two booleans — whether a costing is
       running and whether it is running for this number. That is a state,
       not a figure. What must not appear is any amount or any customer. */
    const raw = JSON.stringify(out.line).toLowerCase();
    for (const absent of ["customer", "price", "floor", "unitcost", "markup", "minor", "rate"]) {
      expect(raw).not.toContain(absent);
    }
    expect(out.line.costing).toEqual({ inSync: true, requested: true });
  });

  test("a line the enquiry does not have is not created by asking for it", async () => {
    const w = await world();
    const err = await refusalOf(() => confirm(w, 500, { productLineRef: "PL-INVENTED" }));
    expect(err.code).toBe(commercialLine.CODES.LINE_NOT_FOUND);
    const stored = await Enquiry.findById(w.enquiry._id).lean();
    expect(stored.commercialLines || []).toHaveLength(0);
  });

  test("a quantity that is not a whole positive number is refused", async () => {
    const w = await world();
    for (const bad of [0, -5, 2.5, "many", null, undefined]) {
      const err = await refusalOf(() => confirm(w, bad));
      expect(err.code).toBe(commercialLine.CODES.VALIDATION);
    }
    expect((await Enquiry.findById(w.enquiry._id).lean()).commercialLines || []).toHaveLength(0);
  });
});

/* ═══ 2 · IT DRIVES THE EXISTING AUTHORITY ═══════════════════════════════ */

describe("the costing follows the line", () => {
  test("confirming writes through the brief authority for that exact quantity", async () => {
    /* ── ONE AUTHORITY, DRIVEN — NOT A SECOND ONE ─────────────────────
       Sales never names a brief. The record Central Costing reads is
       written on their behalf, and it carries the number they confirmed. */
    const w = await world();
    const out = await confirm(w, 500);
    expect(out.costing.requested).toBe(true);
    expect(out.costing.quantity).toBe(500);

    const briefs = await costingBrief.readBriefs(w.ctx, { enquiryId: String(w.enquiry._id) });
    const confirmedBrief = (briefs.briefs || []).find((b) => b.state === "CONFIRMED");
    expect(confirmedBrief).toBeTruthy();
    expect(String(confirmedBrief.sampleStyleId)).toBe(String(w.style._id));
    expect(confirmedBrief.quantities).toHaveLength(1);
    expect(String(confirmedBrief.quantities[0].quantity)).toBe("500");
    expect(confirmedBrief.quantities[0].isPrimary).toBe(true);
  });

  test("the brief is never named back to Sales", async () => {
    const w = await world();
    const out = await confirm(w, 500);
    const raw = JSON.stringify(out);
    expect(raw).not.toContain("briefId");
    expect(raw.toLowerCase()).not.toContain("brief");
  });
});

/* ═══ 3 · CHANGING IT ════════════════════════════════════════════════════ */

describe("revising the quantity", () => {
  test("a change mints a revision, keeps the old one, and re-drives the costing", async () => {
    const w = await world();
    await confirm(w, 500);
    const out = await confirm(w, 800, { reason: "Buyer increased the order." });

    expect(out.changed).toBe(true);
    expect(out.line.quantity).toBe(800);
    expect(out.line.revision).toBe(2);

    /* ── APPEND-ONLY ──────────────────────────────────────────────────
       A quotation already issued was priced on a costing frozen for the
       earlier number, and that pairing stays legible. */
    expect(out.line.revisions.map((r) => [r.revision, r.quantity]))
      .toEqual([[1, 500], [2, 800]]);
    expect(out.line.revisions[1].reason).toBe("Buyer increased the order.");

    /* And the costing authority now holds the new number. */
    const briefs = await costingBrief.readBriefs(w.ctx, { enquiryId: String(w.enquiry._id) });
    const current = (briefs.briefs || []).find((b) => b.state === "CONFIRMED");
    expect(String(current.quantities[0].quantity)).toBe("800");

    /* ── THE OLD BRIEF IS SUPERSEDED, NOT EDITED ──────────────────────
       Editing it would make every version citing it describe a garment it
       was not calculated for. */
    const superseded = (briefs.briefs || []).filter((b) => b.state === "SUPERSEDED");
    expect(superseded.length).toBeGreaterThan(0);
    expect(String(superseded[0].quantities[0].quantity)).toBe("500");
  });

  test("confirming the number already in force changes nothing", async () => {
    /* A double-click, or a replayed request, must not mint a second revision
       or start a second costing. */
    const w = await world();
    await confirm(w, 500);
    const again = await confirm(w, 500);

    expect(again.changed).toBe(false);
    expect(again.line.revision).toBe(1);
    expect(again.line.revisions).toHaveLength(1);

    const stored = await Enquiry.findById(w.enquiry._id).lean();
    expect(stored.commercialLines).toHaveLength(1);
    expect(stored.commercialLines[0].revisions).toHaveLength(1);
  });

  test("two products on one enquiry keep separate lines", async () => {
    const w = await world();
    await Enquiry.updateOne({ _id: w.enquiry._id },
      { $push: { products: { product: "Second polo", quantity: 100 } } });
    const stored = await Enquiry.findById(w.enquiry._id).lean();
    const secondRef = String(stored.products[1].productLineRef);
    expect(secondRef).not.toBe(w.productLineRef);

    await confirm(w, 500);
    const lines = await commercialLine.readLines(w.ctx, { enquiryId: String(w.enquiry._id) });
    expect(lines.lines).toHaveLength(1);
    expect(lines.lines[0].productLineRef).toBe(w.productLineRef);
  });
});

/* ═══ 4 · OWNERSHIP ══════════════════════════════════════════════════════ */

describe("ownership", () => {
  test("another company's enquiry is not found, never refused by name", async () => {
    const mine = await world();
    const theirs = await world();
    const err = await refusalOf(() => commercialLine.confirmQuantity(mine.ctx, {
      enquiryId: String(theirs.enquiry._id),
      productLineRef: theirs.productLineRef,
      sampleStyleId: String(theirs.style._id),
      quantity: 500, actor,
    }));
    expect(err.code).toBe(commercialLine.CODES.NOT_FOUND);
    const stored = await Enquiry.findById(theirs.enquiry._id).lean();
    expect(stored.commercialLines || []).toHaveLength(0);
  });

  test("a read is scoped the same way", async () => {
    const mine = await world();
    const theirs = await world();
    const err = await refusalOf(() => commercialLine.readLines(mine.ctx, {
      enquiryId: String(theirs.enquiry._id),
    }));
    expect(err.code).toBe(commercialLine.CODES.NOT_FOUND);
  });
});

/* ═══ 5 · THE BOUNDARY BETWEEN THE TWO WRITES ════════════════════════════ */

describe("a failure between the line and its costing", () => {
  /**
   * ── WHY THIS BOUNDARY IS NOT ATOMIC ───────────────────────────────────────
   * The commercial line and the hidden costing request land on the same
   * Enquiry document, but through two separately loaded copies of it: the
   * costing authority loads and saves its own instance, and handing it a
   * session would change a signature every other caller depends on.
   *
   * So it is made RECOVERABLE instead. The line is the decision and commits
   * first. The costing follows it. A failure in between leaves the two
   * visibly disagreeing rather than silently agreeing on the wrong number,
   * and confirming again heals it.
   *
   * The danger this closes is a floor price calculated for 500 being shown
   * beside a confirmed quantity of 800.
   */

  test("the quantity stands, the costing is reported out of sync, and a retry heals it", async () => {
    const w = await world();
    await confirm(w, 500);

    /* ── THE COSTING WRITE FAILS AFTER THE LINE IS COMMITTED ──────────── */
    const realConfirm = costingBrief.confirmBrief;
    jest.spyOn(costingBrief, "confirmBrief").mockImplementationOnce(() => {
      throw new Error("simulated failure after the commercial line was written");
    });

    const out = await confirm(w, 800, { reason: "Buyer increased the order." });
    costingBrief.confirmBrief = realConfirm;

    /* The DECISION stands — it is a commercial fact and does not depend on a
       calculation succeeding. */
    expect(out.changed).toBe(true);
    expect(out.line.quantity).toBe(800);
    expect(out.line.revision).toBe(2);

    /* ── AND THE DISAGREEMENT IS REPORTED, NOT HIDDEN ─────────────────── */
    expect(out.line.costing.inSync).toBe(false);
    expect(out.costing.requested).toBe(false);

    /* The costing really is still on the old number — this is the state that
       would otherwise show a 500-piece floor beside an 800-piece order. */
    const stranded = await Enquiry.findById(w.enquiry._id).lean();
    expect(commercialLine.costingQuantityFor(stranded, w.style._id)).toBe(500);

    /* A read says so too, so a screen cannot draw a floor in the meantime. */
    const read = await commercialLine.readLines(w.ctx, { enquiryId: String(w.enquiry._id) });
    expect(read.lines[0].quantity).toBe(800);
    expect(read.lines[0].costing.inSync).toBe(false);

    /* ── CONFIRMING AGAIN IS THE RETRY ────────────────────────────────
       The same number, so no second revision — and the costing is driven
       again, which is what heals it. */
    const healed = await confirm(w, 800);
    expect(healed.changed).toBe(false);
    expect(healed.line.revision).toBe(2);
    expect(healed.line.revisions).toHaveLength(2);
    expect(healed.line.costing.inSync).toBe(true);

    const after = await Enquiry.findById(w.enquiry._id).lean();
    expect(commercialLine.costingQuantityFor(after, w.style._id)).toBe(800);

    /* And the earlier decision is still legible: superseded, never rewritten. */
    const briefs = await costingBrief.readBriefs(w.ctx, { enquiryId: String(w.enquiry._id) });
    const superseded = (briefs.briefs || []).filter((b) => b.state === "SUPERSEDED");
    expect(superseded.map((b) => String(b.quantities[0].quantity))).toContain("500");
  });

  test("a costing that never started is out of sync, not silently ready", async () => {
    /* Absent is not agreement. A line whose costing has not run must never
       report itself in sync, or the screen would show a floor that does not
       exist yet. */
    const w = await world();
    const realSave = costingBrief.saveBrief;
    jest.spyOn(costingBrief, "saveBrief").mockImplementationOnce(() => {
      throw new Error("simulated failure before the costing request was written");
    });

    const out = await confirm(w, 500);
    costingBrief.saveBrief = realSave;

    expect(out.line.quantity).toBe(500);
    expect(out.line.costing).toEqual({ inSync: false, requested: false });

    const healed = await confirm(w, 500);
    expect(healed.line.costing).toEqual({ inSync: true, requested: true });
  });

  test("a business refusal is reported without undoing the decision", async () => {
    /* An unapproved style cannot be costed. The quantity is still Sales'
       decision and still stands; what they are told is why the calculation
       has not started, in the authority's own words. */
    const w = await world();
    await SampleStyle.updateOne({ _id: w.style._id },
      { $set: { "techSheet.technical.status": "draft", "techSheet.status": "draft" } });

    const out = await confirm(w, 500);
    expect(out.line.quantity).toBe(500);
    expect(out.costing.requested).toBe(false);
    expect(out.costing.reason).toBeTruthy();
    expect(out.line.costing.inSync).toBe(false);
  });
});

/* ═══ 6 · A PRICE BEFORE A FLOOR IS A PRICE AGAINST NOTHING ══════════════ */

describe("the selling-price gate on the write path", () => {
  /**
   * ── WHY THE SERVER AND NOT ONLY THE SCREEN ────────────────────────────────
   * The pricing sheet hides the selling-price cell until a floor exists. That
   * is a screen gate, and a screen gate is not a rule: a stale tab, a replayed
   * request or a direct call walks straight past it. The floor is the
   * company's minimum for this garment AT THE CONFIRMED QUANTITY, and the
   * below-floor exception — which exists so that going under is a decision
   * somebody takes deliberately — has nothing to measure against without one.
   */
  const express = require("express");
  const jwt = require("jsonwebtoken");
  const Employee = require("../../models/Employee");
  const DeptUser = require("../../models/Access/DeptUser");
  const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");

  let server, base;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use("/api/cms/crm/enquiries", require("../../routes/CMS_Routes/Sales/enquiries"));
    await new Promise((r) => { server = app.listen(0, r); });
    base = `http://127.0.0.1:${server.address().port}/api/cms/crm/enquiries`;
  }, 300000);

  afterAll(async () => { if (server) await new Promise((r) => server.close(r)); }, 60000);

  async function salesUser(co) {
    const n = ++seq;
    const email = `price-${n}@test.example`;
    const emp = await Employee.create({
      firstName: "P", lastName: `S${n}`, email, biometricId: `PS${n}`,
      isActive: true, gender: "Other", department: "Tech",
    });
    await DeptUser.create({
      name: "Admin", email, passwordHash: "x", isAdmin: true, isActive: true,
      departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
    });
    await SpCompanyMembership.create({
      companyId: co._id, email, employeeRef: emp._id, personName: `P S${n}`,
    });
    return {
      user: { id: String(emp._id), email, name: `P S${n}`, employeeId: emp.biometricId },
      token: jwt.sign({ id: String(emp._id), email, name: `P S${n}`, role: "employee" },
        process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "30m" }),
    };
  }

  const setPrice = (w, me, price) => fetch(
    `${base}/${w.enquiry._id}/products/${encodeURIComponent(w.enquiry.products[0].product)}/cost-ledger`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${me.token}`,
        "X-Costing-Company": String(w.co._id),
      },
      body: JSON.stringify({ price }),
    },
  ).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

  test("no confirmed quantity means no selling price", async () => {
    const w = await world();
    const me = await salesUser(w.co);
    global.__ACTOR__ = me.user;

    const res = await setPrice(w, me, 900);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("SELLING_PRICE_NOT_READY");
    expect(res.body.error.details.reason).toBe("QUANTITY_NOT_CONFIRMED");
    /* The refusal names what to do, not merely that it cannot be done. */
    expect(res.body.message).toMatch(/Confirm the commercial quantity/i);

    const stored = await Enquiry.findById(w.enquiry._id).lean();
    expect((stored.costLedger || []).find((l) => l.price)).toBeFalsy();
  });

  test("a quantity whose costing has not caught up means no selling price either", async () => {
    const w = await world();
    const me = await salesUser(w.co);
    global.__ACTOR__ = me.user;

    /* Confirm, then strand the costing on the old number — the exact state
       the recoverable boundary can leave behind. */
    await confirm(w, 500);
    jest.spyOn(costingBrief, "confirmBrief").mockImplementationOnce(() => {
      throw new Error("simulated failure after the commercial line was written");
    });
    await confirm(w, 800);
    jest.restoreAllMocks();

    const res = await setPrice(w, me, 900);
    expect(res.status).toBe(409);
    expect(res.body.error.details.reason).toBe("COSTING_NOT_IN_SYNC");
  });

  test("clearing a price is always allowed — withdrawing a number is not quoting one", async () => {
    const w = await world();
    const me = await salesUser(w.co);
    global.__ACTOR__ = me.user;

    const res = await setPrice(w, me, null);
    expect(res.status).toBe(200);
  });

  test("a confirmed, in-sync quantity with no floor yet is still refused", async () => {
    /* ── FAIL CLOSED ──────────────────────────────────────────────────
       The quantity is settled and the costing is running for it, but no
       approved version has produced a floor. There is still nothing for a
       price to sit above or below. */
    const w = await world();
    const me = await salesUser(w.co);
    global.__ACTOR__ = me.user;

    const line = await confirm(w, 500);
    expect(line.line.costing.inSync).toBe(true);

    const res = await setPrice(w, me, 900);
    expect(res.status).toBe(409);
    expect(res.body.error.details.reason).toBe("FLOOR_NOT_AVAILABLE");

    const stored = await Enquiry.findById(w.enquiry._id).lean();
    expect((stored.costLedger || []).find((l) => l.price)).toBeFalsy();
  });
});

/* ═══ 7 · THE CONFIRMED QUANTITY IS THE ONLY ONE A QUOTATION MAY CARRY ═══ */

describe("a quotation line cannot name its own quantity", () => {
  /**
   * ── THE DEFECT THIS CLOSES ────────────────────────────────────────────────
   * The PRICE on a sourced line is resolved server-side and replaces whatever
   * was posted. The QUANTITY was not: it came straight off the request body.
   * So a stale tab, a replayed request or a direct call could quote 500 against
   * a costing the company calculated for 750 — and every figure on the document
   * would be internally consistent and wrong.
   *
   * It is REFUSED rather than silently corrected. A price may be replaced,
   * because the company owns the price. How many a customer is buying is a
   * commercial fact somebody agreed, and quietly changing it would issue a
   * document nobody chose.
   */
  const quotationPricing = require("../../services/centralCosting/quotationPricing.service");

  test("the mismatch refusal has its own code", () => {
    expect(quotationPricing.CODES.QUANTITY_NOT_CONFIRMED)
      .toBe("QUOTATION_LINE_QUANTITY_NOT_CONFIRMED");
    /* Distinct from every other refusal here: what to do about it — reload
       and price the agreed quantity — differs from all of them. */
    const codes = Object.values(quotationPricing.CODES);
    expect(new Set(codes).size).toBe(codes.length);
  });

  test("a line naming the quantity nobody confirmed is refused, naming both", async () => {
    const w = await world();
    await confirm(w, 750);

    const r = await quotationPricing.priceLine(
      { companyId: w.co._id },
      {
        itemName: "Polo",
        /* The buyer's opening ask on the enquiry, and the number a stale
           screen would still be showing. */
        quantity: 500,
        costingIntent: { sampleStyleId: String(w.style._id), tier: "floor" },
      },
      { currency: "INR", index: 0 },
    );

    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("QUOTATION_LINE_QUANTITY_NOT_CONFIRMED");
    expect(r.error.confirmedQuantity).toBe(750);
    expect(r.error.submittedQuantity).toBe(500);
    /* Both numbers are named, so the refusal is actionable rather than
       "that quantity is wrong". */
    expect(r.error.message).toMatch(/750/);
    expect(r.error.message).toMatch(/500/);
  });

  test("the confirmed quantity is accepted", async () => {
    const w = await world();
    await confirm(w, 750);

    const r = await quotationPricing.priceLine(
      { companyId: w.co._id },
      {
        itemName: "Polo", quantity: 750,
        costingIntent: { sampleStyleId: String(w.style._id), tier: "floor" },
      },
      { currency: "INR", index: 0 },
    );
    /* It gets past the quantity gate. Whether a floor exists for it is the
       NEXT question, and a different refusal. */
    expect(r.error?.code).not.toBe("QUOTATION_LINE_QUANTITY_NOT_CONFIRMED");
  });

  test("a revision moves the only quantity a quotation may carry", async () => {
    /* 500 → 750. Afterwards 500 is refused and 750 is not, which is the whole
       behaviour in one assertion pair. */
    const w = await world();
    await confirm(w, 500);
    await confirm(w, 750, { reason: "Buyer increased the order." });

    const line = (q) => quotationPricing.priceLine(
      { companyId: w.co._id },
      { itemName: "Polo", quantity: q, costingIntent: { sampleStyleId: String(w.style._id), tier: "floor" } },
      { currency: "INR", index: 0 },
    );

    expect((await line(500)).error.code).toBe("QUOTATION_LINE_QUANTITY_NOT_CONFIRMED");
    expect((await line(750)).error?.code).not.toBe("QUOTATION_LINE_QUANTITY_NOT_CONFIRMED");

    /* And the enquiry's own product quantity is untouched by any of it —
       what the buyer asked for is not what the company agreed to sell. */
    const stored = await Enquiry.findById(w.enquiry._id).lean();
    expect(stored.products[0].quantity).toBe(250);
    expect(stored.commercialLines[0].quantity).toBe(750);
    expect(stored.commercialLines[0].revisions.map((r) => r.quantity)).toEqual([500, 750]);
  });

  /* ═══ THE SECOND DEFECT: THE CHECK FAILED OPEN ══════════════════════════
   *
   * The first version compared the submitted quantity only when it FOUND a
   * confirmed line. Missing, ambiguous or unreadable all returned "unknown",
   * and unknown was treated as permission to carry on with the client's own
   * number. So the verification could be switched off by sending LESS: omit
   * the product line, or arrange two candidates, and nothing was checked.
   *
   * A check that can be avoided by sending less is not a check. Every state
   * below is now a refusal with its own code, and each test here fails if the
   * corresponding branch is removed.
   */

  /** A second product line on the same enquiry, so two lines can compete. */
  async function secondProductLine(w, name = "second colourway") {
    const doc = await Enquiry.findById(w.enquiry._id);
    doc.products.push({ product: name, quantity: 250 });
    await doc.save();
    const saved = await Enquiry.findById(w.enquiry._id).lean();
    return String(saved.products[saved.products.length - 1].productLineRef);
  }

  /** Another approved style on the same enquiry. */
  async function secondStyle(w) {
    return SampleStyle.create({
      sampleStyleId: `SS-CL-B-${++seq}`, styleCode: `SC-CL-B-${seq}`, companyId: w.co._id,
      productName: "other", journeyId: w.enquiry.journeyId, enquiryId: w.enquiry._id,
      stage: "rnd", materials: { status: "selected", rawItems: [] },
    });
  }

  const price = (w, item) => quotationPricing.priceLine(
    { companyId: w.co._id }, item, { currency: "INR", index: 0 },
  );

  const intentFor = (w, over = {}) => ({
    sampleStyleId: String(w.style._id), tier: "floor", ...over,
  });

  test("no commercial line at all is refused, not waved through", async () => {
    /* ── THE EXACT FAIL-OPEN CASE ─────────────────────────────────────
       Nothing confirmed for this style. Previously the submitted 500 was
       priced. There is no number here to have agreed with, so there is
       nothing to quote. */
    const w = await world();
    const r = await price(w, { itemName: "Polo", quantity: 500, costingIntent: intentFor(w) });

    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("QUOTATION_LINE_NO_COMMERCIAL_LINE");
    expect(r.error.message).toMatch(/Confirm the quantity/i);
    /* And the client's number went nowhere. */
    expect(r.patch).toBeUndefined();
  });

  test("two candidate lines are refused rather than guessed between", async () => {
    /* One enquiry carrying the same garment twice — two colourways, two
       commercial lines, one style. Choosing one would be choosing for the
       company. */
    const w = await world();
    const ref2 = await secondProductLine(w);
    await confirm(w, 750);
    await confirm(w, 750, { productLineRef: ref2 });

    const r = await price(w, { itemName: "Polo", quantity: 750, costingIntent: intentFor(w) });

    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("QUOTATION_LINE_COMMERCIAL_LINE_AMBIGUOUS");
    expect(r.error.candidates).toBe(2);
    expect(r.error.message).toMatch(/Name the product line/i);
  });

  test("a product line reference that is not this style's is refused", async () => {
    /* The pair is the key. A reference that belongs to no line on this style
       does not resolve to whichever line happens to be there. */
    const w = await world();
    await confirm(w, 750);

    const r = await price(w, {
      itemName: "Polo", quantity: 750,
      costingIntent: intentFor(w, { productLineRef: "PL-SOMETHING-ELSE" }),
    });

    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("QUOTATION_LINE_COMMERCIAL_LINE_NOT_FOUND");
  });

  test("a real line on the WRONG style does not answer for this one", async () => {
    /* ── BOTH HALVES, TOGETHER ────────────────────────────────────────
       `ref2` is a genuine product line with a genuine confirmed commercial
       line — on a different style. Matching on the reference alone would
       hand this quotation another garment's quantity. */
    const w = await world();
    const ref2 = await secondProductLine(w);
    const other = await secondStyle(w);
    await confirm(w, 750);
    await confirm(w, 1200, { productLineRef: ref2, sampleStyleId: String(other._id) });

    const r = await price(w, {
      itemName: "Polo", quantity: 1200,
      costingIntent: intentFor(w, { productLineRef: ref2 }),
    });

    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("QUOTATION_LINE_COMMERCIAL_LINE_NOT_FOUND");
  });

  test("a line whose costing has not caught up is refused by name", async () => {
    /* The recoverable boundary: the line committed, the costing did not
       follow. The quantity is confirmed and it is the one submitted — and
       there is still no price approved for it. */
    const w = await world();
    await confirm(w, 500);
    jest.spyOn(costingBrief, "confirmBrief").mockImplementationOnce(() => {
      throw new Error("simulated failure after the commercial line was written");
    });
    await confirm(w, 750);
    jest.restoreAllMocks();

    const r = await price(w, { itemName: "Polo", quantity: 750, costingIntent: intentFor(w) });

    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("QUOTATION_LINE_COSTING_NOT_IN_SYNC");
    /* Named as its own state: retrying the confirmation heals this one,
       which is not true of any other refusal here. */
    expect(r.error.reason).toBe("COSTING_NOT_IN_SYNC");
  });

  test("omitting the intent is not a way round the check", async () => {
    /* ── THE LAST DOOR ────────────────────────────────────────────────
       Everything above is reached by SENDING a `costingIntent`. A client
       that sends none used to take the manual path and type its own price
       on a style the company has a floor for. */
    const w = await world();
    await confirm(w, 750);

    const r = await price(w, {
      itemName: "Polo", quantity: 500, unitPrice: 9,
      sampleStyleId: String(w.style._id),
    });

    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("QUOTATION_LINE_COSTING_INTENT_REQUIRED");
    expect(r.error.message).toMatch(/approved/i);
  });

  test("naming only the stock item is the same bypass, and is closed too", async () => {
    /* ── THE EDITOR'S OWN LINES NAME A PRODUCT, NOT A STYLE ───────────
       Dropping `costingIntent` AND `sampleStyleId` left a line that still
       identified the garment — through the item-master product SampleStyle
       stores. The style is resolved from that stored link, so the refusal
       does not depend on which of the two fields a client chose to send. */
    const w = await world();
    await confirm(w, 750);
    await SampleStyle.updateOne(
      { _id: w.style._id },
      { $set: { "production.stockItemId": new mongoose.Types.ObjectId(), isActive: true } },
    );
    const linked = await SampleStyle.findById(w.style._id).lean();

    const r = await price(w, {
      itemName: "Polo", quantity: 500, unitPrice: 9,
      stockItemId: linked.production.stockItemId,
    });

    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("QUOTATION_LINE_COSTING_INTENT_REQUIRED");
  });

  test("a line for no style at all is untouched", async () => {
    /* Freight, a sample charge, a rebate. Nothing here is governed by a
       commercial line and nothing about it changes. */
    const w = await world();
    await confirm(w, 750);

    const r = await price(w, { itemName: "Freight", quantity: 1, unitPrice: 4500 });
    expect(r.ok).toBe(true);
    expect(r.sourced).toBe(false);
    expect(r.patch.unitPrice).toBe(4500);
  });

  test("and the save route runs the pass whether or not an intent was sent", () => {
    /* The service refuses, but only if it is CALLED. The route used to
       decide that from `costingIntent` alone, so omitting the field skipped
       the whole pass — the refusal above would never have run. */
    expect(quotationPricing.needsPricingPass([{ itemName: "Freight" }])).toBe(false);
    expect(quotationPricing.needsPricingPass([{ sampleStyleId: "abc" }])).toBe(true);
    expect(quotationPricing.needsPricingPass([{ stockItemId: "abc" }])).toBe(true);
    expect(quotationPricing.needsPricingPass([
      { itemName: "Freight" }, { sampleStyleId: "abc" },
    ])).toBe(true);

    const route = bare(fs.readFileSync(
      path.join(__dirname, "../../routes/CMS_Routes/Sales/quotationRoutes.js"), "utf8",
    ));
    /* Both save doors, and neither gating on the client's own field. */
    expect(route.split("quotationPricing.needsPricingPass(").length - 1).toBe(2);
    expect(route).not.toMatch(/some\(\(i\) => quotationPricing\.readIntent\(i\)\)/);
  });

  test("a match is priced from the SERVER's quantity, not the body's", async () => {
    /* ── WHICH COPY OF THE NUMBER IS STORED ───────────────────────────
       The body here carries NO quantity at all, so nothing of the client's
       could be echoed back. What the costing is looked up for, and what
       lands on the stored line, is the 750 read from the commercial line. */
    const w = await world();
    await confirm(w, 750);

    const approvedOutput = require("../../services/centralCosting/approvedOutput.service");
    const seen = [];
    jest.spyOn(approvedOutput, "resolveLinkForLine").mockImplementation(async (ctx, args) => {
      seen.push(args);
      return {
        available: true,
        provenance: {
          source: "central_costing", costingId: new mongoose.Types.ObjectId(),
          costingVersionId: new mongoose.Types.ObjectId(), costingVersionNumber: 1,
          sampleStyleId: String(w.style._id), styleCode: "SC", productName: "Polo",
          scenarioKey: "q750", quantity: 750, priceTier: "floor",
          unitPriceMinor: 60000, currency: "INR",
          linkedAt: new Date(), approvedAt: new Date(), assumptions: {}, fingerprint: "fp",
        },
      };
    });

    const r = await price(w, { itemName: "Polo", costingIntent: intentFor(w) });
    jest.restoreAllMocks();

    expect(r.ok).toBe(true);
    expect(seen[0].quantity).toBe("750");
    expect(r.patch.quantity).toBe(750);
    expect(r.patch.unitPrice).toBe(600);
  });

  test("a stored historical quotation is still readable and sendable", async () => {
    /* ── HISTORY IS NOT A BYPASS, AND NOT A CASUALTY ──────────────────
       A quotation stored before any of this carries a manual line on what
       is now a governed style. Sending it is unaffected: there is no
       stamped source to have moved. What is refused is SUBMITTING that same
       line again today, which is the previous test. */
    const w = await world();
    await confirm(w, 750);

    const verdict = await quotationPricing.verifyBeforeSend(
      { companyId: w.co._id },
      { items: [{ itemName: "Polo", quantity: 500, unitPrice: 9, sampleStyleId: String(w.style._id) }] },
    );

    expect(verdict.ok).toBe(true);
    expect(verdict.problems).toHaveLength(0);
  });

  test("every new refusal has its own code", () => {
    const C = quotationPricing.CODES;
    expect(C.NO_COMMERCIAL_LINE).toBe("QUOTATION_LINE_NO_COMMERCIAL_LINE");
    expect(C.AMBIGUOUS_LINE).toBe("QUOTATION_LINE_COMMERCIAL_LINE_AMBIGUOUS");
    expect(C.LINE_NOT_FOUND).toBe("QUOTATION_LINE_COMMERCIAL_LINE_NOT_FOUND");
    expect(C.LINE_OUT_OF_SYNC).toBe("QUOTATION_LINE_COSTING_NOT_IN_SYNC");
    expect(C.INTENT_REQUIRED).toBe("QUOTATION_LINE_COSTING_INTENT_REQUIRED");
    const codes = Object.values(C);
    expect(new Set(codes).size).toBe(codes.length);
  });

  test("sync is asked of the commercial-line authority, not restated here", () => {
    /* ── ONE DEFINITION ───────────────────────────────────────────────
       A second opinion about whether the costing matches the line is the
       one that drifts. This module asks `costingQuantityFor` rather than
       reading a brief itself. */
    const src = bare(fs.readFileSync(
      path.join(__dirname, "../../services/centralCosting/quotationPricing.service.js"), "utf8",
    ));
    expect(src).toMatch(/commercialLine\.costingQuantityFor\(/);
    /* The briefs are PROJECTED — the authority reads them off the document
       handed to it. What must not appear is this module forming its own
       opinion from them: no brief service, and no second definition of
       which brief counts or which quantity on it is the one. */
    expect(src).not.toMatch(/require\([^)]*costingBrief/);
    expect(src).not.toMatch(/["']CONFIRMED["']/);
    expect(src).not.toMatch(/isPrimary/);
  });
});
