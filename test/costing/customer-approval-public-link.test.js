// test/costing/customer-approval-public-link.test.js
//
// THE CUSTOMER'S OWN LINK, DRIVEN AS A CUSTOMER DRIVES IT.
//
// ── NO SESSION, ON PURPOSE ──────────────────────────────────────────────────
// A customer follows a link from an email. They have no account, no cookie and
// no bearer token, and every request in this file is sent that way: nothing
// sets `global.__ACTOR__`, so the mocked Sales middleware would refuse anything
// it guarded. This route is not guarded by it, and that is the point.
//
// ── THE DEFECT THIS SUITE WOULD HAVE CAUGHT ─────────────────────────────────
// `customerNameFor(enquiry, req)` called `scoped(req, …)`, and `salesScope`
// opens with `if (!req.user?.id) throw UNAUTHENTICATED`. So the route answered
// 401 to every customer, before writing anything. It was unusable in
// production — the decision a customer thought they had recorded was never
// recorded — and a suite that only read the source could not see it.
//
// The scope now comes from the enquiry the opaque token resolved to, which is
// narrower than a session's: one company, named by the authorised record.
//
// ── AND THE SHAPE THAT BREAKS NAME LOOKUPS ──────────────────────────────────
// One enquiry, TWO colourways of one garment — same product NAME, different
// permanent references, different styles, different approved selling prices:
//
//   Sand  PL-…a  ₹900
//   Navy  PL-…b  ₹750
//
// The approval used to find a ledger row with `.find(l => l.productName === …)`
// and take the FIRST, then write that one figure onto the linked stock item's
// `baseSalesPrice` and EVERY variant. So approving Sand could publish Navy's
// price, across colourways that never shared one.
//
// No real customer data: every name, email and reference here is generated.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

/* Firebase-dependent notification plumbing, stubbed at the edge. None of it
   participates in a pricing or tenancy decision. */
jest.mock("../../config/firebaseAdmin", () => ({ messaging: () => ({ send: async () => ({}) }) }));
jest.mock("../../services/NotificationService", () => ({
  notify: async () => ({}), notifyUser: async () => ({}), send: async () => ({}),
}));
jest.mock("../../services/departmentNotify.service", () => ({
  notifyEvent: async () => ({}), APP_URL: "http://localhost",
}));
jest.mock("../../services/cowork.service", () => ({}), { virtual: true });
jest.mock("../../services/coworkSheets.service", () => ({}), { virtual: true });

/* ── THE SALES GUARD IS REAL, AND REFUSES ───────────────────────────────────
   Not stubbed away: this suite's whole claim is that the approval link works
   with NO session, so the guard has to be present and answering 401 to
   anything it protects. `global.__ACTOR__` is never set. */
jest.mock("../../Middlewear/SalesAuthMiddlewear", () => {
  const mw = (req, res, next) => {
    if (!global.__ACTOR__) return res.status(401).json({ success: false, message: "no session" });
    req.user = global.__ACTOR__;
    next();
  };
  mw.withRoles = () => mw;
  return mw;
});

const express = require("express");
const mongoose = require("mongoose");
const crypto = require("crypto");

const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
const Account = require("../../models/CMS_Models/Sales/Account");
const StockItem = require("../../models/CMS_Models/Inventory/Products/StockItem");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/", require("../../routes/CMS_Routes/Sales/enquiries"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { if (server) await new Promise((r) => server.close(r)); });
afterEach(() => { global.__ACTOR__ = null; });

/** A request with no session of any kind — a customer's browser. */
const asCustomer = (path_, { method = "POST", body } = {}) =>
  fetch(`${base}${path_}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => {
    const raw = await r.text();
    let parsed = null;
    try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = { nonJson: raw.slice(0, 200) }; }
    return { status: r.status, body: parsed };
  });

const ref = () => `PL-${crypto.randomBytes(6).toString("hex")}`;

const SAND_PRICE = 900;
const NAVY_PRICE = 750;
const BASE_SALES_PRICE = 100;
const VARIANT_A_PRICE = 100;
const VARIANT_B_PRICE = 111;

/**
 * Two colourways of one garment, each with its own approved selling price, and
 * a linked stock item whose catalogue prices are all different from both.
 *
 * Every figure is distinct, so if any of them ends up anywhere it did not
 * belong, the assertion that catches it names which one travelled.
 */
async function world() {
  const n = ++seq;
  const co = await Acc_Company.create({
    companyName: `QA Approval ${n}`, booksFromDate: new Date("2026-04-01"),
  });
  const account = await Account.create({
    companyId: co._id,
    displayName: `QA Buyer ${n}`,
    companyName: `QA Buyer ${n} Ltd`,
    primaryEmail: `qa-buyer-${n}@example.com`,
  });

  const sandRef = ref();
  const navyRef = ref();
  const sandStyle = new mongoose.Types.ObjectId();
  const navyStyle = new mongoose.Types.ObjectId();

  /* ── THE CATALOGUE, LINKED TO THE FIRST COLOURWAY ──────────────────────
     Two variants at two prices, neither of which is either colourway's
     approved price. */
  const stock = await StockItem.create({
    companyId: co._id,
    name: `QA blazer ${n}`,
    reference: `QAB-${n}`,
    category: "Apparel",
    createdBy: new mongoose.Types.ObjectId(),
    baseSalesPrice: BASE_SALES_PRICE,
    variants: [
      { combination: ["Sand"], sku: `QAB-${n}-S`, quantity: 0, salesPrice: VARIANT_A_PRICE, cost: 50, attributes: [] },
      { combination: ["Navy"], sku: `QAB-${n}-N`, quantity: 0, salesPrice: VARIANT_B_PRICE, cost: 50, attributes: [] },
    ],
  });

  /* The token the email carries. Only its hash is ever stored. */
  const token = `qa-tok-${n}-${crypto.randomBytes(8).toString("hex")}`;
  const hash = crypto.createHash("sha256").update(token).digest("hex");

  const enquiry = await Enquiry.create({
    companyId: co._id,
    enquiryId: `ENQ-QA-${n}`,
    title: `QA approval ${n}`,
    accountId: account._id,
    journeyId: new mongoose.Types.ObjectId(),
    isActive: true,
    /* ── ONE NAME, TWO LINES ────────────────────────────────────────────
       The case every name-keyed lookup gets wrong. */
    products: [
      { productLineRef: sandRef, product: "Blazer", quantity: 500, stockItemId: stock._id },
      { productLineRef: navyRef, product: "Blazer", quantity: 400 },
    ],
    /* Each colourway's own approved selling price, keyed by the pair. */
    costLedger: [
      { productName: "Blazer", productLineRef: sandRef, sampleStyleId: sandStyle, price: SAND_PRICE },
      { productName: "Blazer", productLineRef: navyRef, sampleStyleId: navyStyle, price: NAVY_PRICE },
    ],
    /* A live approval link, for the NAME both lines share. */
    costingLifecycle: [{
      productName: "Blazer",
      customerApprovalTokenHash: hash,
      customerApprovalTokenExpiresAt: new Date(Date.now() + 3600_000),
    }],
  });

  return { co, account, enquiry, stock, token, sandRef, navyRef, n };
}

const reread = async (w) => ({
  enquiry: await Enquiry.findById(w.enquiry._id).lean(),
  stock: await StockItem.findById(w.stock._id).lean(),
});

const ledgerFor = (enquiry, productLineRef) =>
  (enquiry.costLedger || []).find((l) => String(l.productLineRef) === String(productLineRef)) || null;

/* ═══ 1 · THE LINK WORKS WITHOUT A SESSION ════════════════════════════════ */

describe("the public customer-approval link", () => {
  test("a customer with no session records an approval, and is not refused", async () => {
    /* ── THE PRODUCTION DEFECT ────────────────────────────────────────────
        This answered 401 for every customer: `customerNameFor` scoped its
        account lookup to a Sales session the customer does not have. */
    const w = await world();

    const r = await asCustomer(`/costing-approval/${w.token}/decide`, {
      body: { approved: true, note: "Happy with the price." },
    });

    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
  });

  test("and the Sales guard is genuinely present — a guarded door still refuses", async () => {
    /* Proves the test above is not passing because the guard was stubbed
       open. The same session-less request to an authenticated door is 401. */
    const w = await world();
    const guarded = await asCustomer(`/${w.enquiry._id}/proforma-request`, { body: {} });
    expect(guarded.status).toBe(401);
  });

  test("the approval is recorded on the record, with the decision and the note", async () => {
    const w = await world();
    await asCustomer(`/costing-approval/${w.token}/decide`, {
      body: { approved: true, note: "Approved by the buyer." },
    });

    const { enquiry } = await reread(w);
    const entry = enquiry.costingLifecycle.find((c) => c.productName === "Blazer");
    expect(entry.customerApproved).toBe(true);
    expect(entry.customerApprovedAt).toBeTruthy();
    expect(entry.customerDecisionNote).toBe("Approved by the buyer.");
    /* Named from the account — the lookup that used to throw. */
    expect(entry.customerApprovedBy.name).toBe(`QA Buyer ${w.n}`);
    /* Single-use: the hash is cleared, so the link cannot record a second,
       different answer. */
    expect(entry.customerApprovalTokenHash).toBeUndefined();
  });

  test("a declined decision is recorded just as faithfully", async () => {
    const w = await world();
    const r = await asCustomer(`/costing-approval/${w.token}/decide`, {
      body: { approved: false, note: "Too expensive at this quantity." },
    });
    expect(r.status).toBe(200);
    const { enquiry } = await reread(w);
    const entry = enquiry.costingLifecycle.find((c) => c.productName === "Blazer");
    expect(entry.customerApproved).toBe(false);
    expect(entry.customerDecisionNote).toBe("Too expensive at this quantity.");
  });

  test("the link is single-use — a replay cannot overwrite the answer", async () => {
    const w = await world();
    expect((await asCustomer(`/costing-approval/${w.token}/decide`, {
      body: { approved: true, note: "Yes." },
    })).status).toBe(200);

    const again = await asCustomer(`/costing-approval/${w.token}/decide`, {
      body: { approved: false, note: "Changed my mind." },
    });
    expect(again.status).toBe(404);

    const { enquiry } = await reread(w);
    const entry = enquiry.costingLifecycle.find((c) => c.productName === "Blazer");
    expect(entry.customerApproved).toBe(true);
    expect(entry.customerDecisionNote).toBe("Yes.");
  });
});

/* ═══ 2 · THE ITEM MASTER IS NOT TOUCHED ══════════════════════════════════ */

describe("the item master after a customer approval", () => {
  test("baseSalesPrice and EVERY variant price are unchanged", async () => {
    const w = await world();
    const before = await reread(w);
    expect(before.stock.baseSalesPrice).toBe(BASE_SALES_PRICE);
    expect(before.stock.variants.map((v) => v.salesPrice)).toEqual([VARIANT_A_PRICE, VARIANT_B_PRICE]);

    expect((await asCustomer(`/costing-approval/${w.token}/decide`, {
      body: { approved: true, note: "Go ahead." },
    })).status).toBe(200);

    const after = await reread(w);
    expect(after.stock.baseSalesPrice).toBe(BASE_SALES_PRICE);
    /* Every variant, not just the first: the retired sync wrote one figure
       across all of them. */
    expect(after.stock.variants.map((v) => v.salesPrice)).toEqual([VARIANT_A_PRICE, VARIANT_B_PRICE]);
    /* And neither colourway's approved price appears anywhere on the item. */
    const dumped = JSON.stringify(after.stock);
    expect(dumped).not.toContain(String(SAND_PRICE));
    expect(dumped).not.toContain(String(NAVY_PRICE));
  });

  test("the item master is byte-identical apart from nothing at all", async () => {
    /* The strongest form: the document did not change. */
    const w = await world();
    const before = (await reread(w)).stock;
    await asCustomer(`/costing-approval/${w.token}/decide`, { body: { approved: true } });
    const after = (await reread(w)).stock;
    expect(after.updatedAt?.getTime?.()).toBe(before.updatedAt?.getTime?.());
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });
});

/* ═══ 3 · THE TWO COLOURWAYS KEEP THEIR OWN PRICES ════════════════════════ */

describe("colourway isolation through a customer approval", () => {
  test("each colourway retains its own commercial price", async () => {
    const w = await world();
    await asCustomer(`/costing-approval/${w.token}/decide`, { body: { approved: true } });

    const { enquiry } = await reread(w);
    expect(ledgerFor(enquiry, w.sandRef).price).toBe(SAND_PRICE);
    expect(ledgerFor(enquiry, w.navyRef).price).toBe(NAVY_PRICE);
    /* Still two distinct rows — not collapsed onto the shared name. */
    expect(enquiry.costLedger).toHaveLength(2);
  });

  test("no product-name lookup selected the other colourway", async () => {
    /* ── HOW THE OLD DEFECT WOULD SHOW ────────────────────────────────────
       The approval resolved a price by NAME and both rows carry "Blazer", so
       `.find` returned whichever was first and wrote it onto the catalogue.
       Sand's ₹900 landing on the item, or Navy's ₹750 landing anywhere near
       Sand, is that bug. Neither figure may move, and neither may reach the
       stock item. */
    const w = await world();
    await asCustomer(`/costing-approval/${w.token}/decide`, { body: { approved: true } });

    const { enquiry, stock } = await reread(w);
    /* Sand's price did not become Navy's, and Navy's did not become Sand's. */
    expect(ledgerFor(enquiry, w.sandRef).price).not.toBe(NAVY_PRICE);
    expect(ledgerFor(enquiry, w.navyRef).price).not.toBe(SAND_PRICE);
    /* And no colourway price reached the catalogue at all. */
    for (const price of stock.variants.map((v) => v.salesPrice).concat(stock.baseSalesPrice)) {
      expect([SAND_PRICE, NAVY_PRICE]).not.toContain(price);
    }
  });

  test("approving one name does not mark the other line's lifecycle decided", async () => {
    /* Two lifecycle entries under one name, one token. Only the entry the
       token names may move. */
    const w = await world();
    const otherHash = crypto.createHash("sha256").update(`other-${w.n}`).digest("hex");
    await Enquiry.updateOne({ _id: w.enquiry._id }, {
      $push: {
        costingLifecycle: {
          productName: "Blazer",
          customerApprovalTokenHash: otherHash,
          customerApprovalTokenExpiresAt: new Date(Date.now() + 3600_000),
        },
      },
    });

    await asCustomer(`/costing-approval/${w.token}/decide`, { body: { approved: true } });

    const { enquiry } = await reread(w);
    const decided = enquiry.costingLifecycle.filter((c) => c.customerApproved === true);
    expect(decided).toHaveLength(1);
    /* The untouched one still holds its own live token. */
    const untouched = enquiry.costingLifecycle.find((c) => c.customerApprovalTokenHash === otherHash);
    expect(untouched).toBeTruthy();
    /* Undecided, which the schema stores as null rather than absent — the
       claim is that no decision was recorded, not how emptiness is spelled. */
    expect(untouched.customerApproved).not.toBe(true);
    expect(untouched.customerApproved).not.toBe(false);
    expect(untouched.customerApprovedAt == null).toBe(true);
  });
});

/* ═══ 4 · AND THE SCOPE THE TOKEN ESTABLISHES IS NARROW ═══════════════════ */

describe("what the token authorises", () => {
  test("an expired link records nothing", async () => {
    const w = await world();
    await Enquiry.updateOne(
      { _id: w.enquiry._id },
      { $set: { "costingLifecycle.0.customerApprovalTokenExpiresAt": new Date(Date.now() - 1000) } },
    );
    const r = await asCustomer(`/costing-approval/${w.token}/decide`, { body: { approved: true } });
    expect(r.status).toBe(404);
    const { enquiry } = await reread(w);
    /* No decision recorded — null, not a stored `false`, which would be a
       customer having declined. */
    expect(enquiry.costingLifecycle[0].customerApproved).not.toBe(true);
    expect(enquiry.costingLifecycle[0].customerApproved).not.toBe(false);
    expect(enquiry.costingLifecycle[0].customerApprovedAt == null).toBe(true);
    /* And the link is still live rather than consumed by a failed attempt. */
    expect(enquiry.costingLifecycle[0].customerApprovalTokenHash).toBeTruthy();
  });

  test("an unknown token records nothing", async () => {
    const w = await world();
    const r = await asCustomer(`/costing-approval/not-a-real-token/decide`, { body: { approved: true } });
    expect(r.status).toBe(404);
    const { enquiry } = await reread(w);
    /* No decision recorded — null, not a stored `false`, which would be a
       customer having declined. */
    expect(enquiry.costingLifecycle[0].customerApproved).not.toBe(true);
    expect(enquiry.costingLifecycle[0].customerApproved).not.toBe(false);
    expect(enquiry.costingLifecycle[0].customerApprovedAt == null).toBe(true);
    /* And the link is still live rather than consumed by a failed attempt. */
    expect(enquiry.costingLifecycle[0].customerApprovalTokenHash).toBeTruthy();
  });

  test("the account read is pinned to the enquiry's company, not widened", async () => {
    /* ── WHY THIS MATTERS ─────────────────────────────────────────────────
       The session-less branch supplies the company from the enquiry the token
       resolved to. A namesake account in ANOTHER company must not be the one
       named on the decision. */
    const w = await world();
    const other = await Acc_Company.create({
      companyName: `QA Other ${w.n}`, booksFromDate: new Date("2026-04-01"),
    });
    await Account.create({
      companyId: other._id,
      displayName: "WRONG COMPANY ACCOUNT",
      companyName: "WRONG COMPANY ACCOUNT",
      primaryEmail: `wrong-${w.n}@example.com`,
      _id: undefined,
    });

    await asCustomer(`/costing-approval/${w.token}/decide`, { body: { approved: true } });
    const { enquiry } = await reread(w);
    const entry = enquiry.costingLifecycle.find((c) => c.productName === "Blazer");
    expect(entry.customerApprovedBy.name).toBe(`QA Buyer ${w.n}`);
    expect(entry.customerApprovedBy.name).not.toBe("WRONG COMPANY ACCOUNT");
  });
});
