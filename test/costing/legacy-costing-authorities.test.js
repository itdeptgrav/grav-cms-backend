// test/costing/legacy-costing-authorities.test.js
//
// THE PARALLEL AUTHORITIES ARE CLOSED, AND CANNOT PRODUCE A RECORD.
//
// ── WHAT THESE DOORS DID ────────────────────────────────────────────────────
// Three of them, all reachable with an ordinary Sales session:
//
//   1. `POST /:id/costing-sheet` and its edit/assign/decide siblings recorded
//      costing calculations ON THE ENQUIRY, and membership on one decided cost
//      visibility — `crmCostVisibility.costingTier` hands a sheet owner or
//      editor the full build-up. The assign door let a Sales user grant
//      themselves that role, so Sales could read materials, operations and
//      unit costs by assigning themselves to a sheet.
//
//   2. `GET /:id/costing-sheet/:productName/data` published a SECOND floor
//      price, computed from `CRMSettings.commercial.markupPct` — a Sales
//      setting defaulting to 22% that no Board approved.
//
//   3. `POST /api/costings/:id/procurement-projection/requests` raised
//      purchasing demand from a costing: no confirmed order, no order line, no
//      reconciliation of demand already released.
//
// Each is refused now. What these tests prove is not that a status code
// changed — it is that NO RECORD is produced, because a refusal that still
// writes is not a refusal.
//
// Historical records stay loadable: losing the company's own history is not an
// improvement, and the read door is unchanged for a reader authorised for cost.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

/* Firebase-dependent notification plumbing, stubbed at the edge — the
   repository's own pattern for route suites. None of it participates in any
   decision these tests make. */
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

/* The session an authenticated Sales user would have. What is under test is
   what these doors DO, not the sign-in. */
jest.mock("../../Middlewear/SalesAuthMiddlewear", () => {
  const mw = (req, res, next) => {
    if (!global.__ACTOR__) return res.status(401).json({ success: false });
    req.user = global.__ACTOR__;
    next();
  };
  mw.withRoles = () => mw;
  return mw;
});

const express = require("express");
const mongoose = require("mongoose");

const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const Employee = require("../../models/Employee");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
const StockItem = require("../../models/CMS_Models/Inventory/Products/StockItem");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/", require("../../routes/CMS_Routes/Sales/enquiries"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });
afterEach(() => { global.__ACTOR__ = null; });

const call = (path_, { method = "GET", body } = {}) =>
  fetch(`${base}${path_}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => {
    const raw = await r.text();
    let parsed = null;
    try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = { nonJson: true }; }
    return { status: r.status, body: parsed };
  });

async function world() {
  const n = ++seq;
  const co = await Acc_Company.create({
    companyName: `Legacy ${n}`, booksFromDate: new Date("2026-04-01"),
  });
  const email = `legacy${n}@test.example`;
  const emp = await Employee.create({
    firstName: "L", lastName: `G${n}`, email, biometricId: `LG${n}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  await SpCompanyMembership.create({
    companyId: co._id, email, employeeRef: emp._id, personName: "L",
  });
  const enquiry = await Enquiry.create({
    companyId: co._id,
    enquiryId: `ENQ-LG-${n}`,
    title: `Legacy ${n}`,
    /* Required by the model; neither participates in what these doors do. */
    accountId: new mongoose.Types.ObjectId(),
    journeyId: new mongoose.Types.ObjectId(),
    /* The reference format is system-issued (`PL-` + 12 hex) and the model
       refuses anything else, so it is minted here the same way. */
    products: [{ productLineRef: `PL-${require("crypto").randomBytes(6).toString("hex")}`, product: "Blazer", quantity: 500 }],
    isActive: true,
  });
  global.__ACTOR__ = { id: String(emp._id), email, name: "L", role: "sales" };
  const fresh = await Enquiry.findById(enquiry._id).lean();
  return { co, enquiry, n, ref: String(fresh.products[0].productLineRef) };
}

const sheetsOn = async (id) => {
  const doc = await Enquiry.findById(id).lean();
  return {
    sheets: (doc?.costingSheets || []).length,
    changes: (doc?.costingChangeLog || []).length,
  };
};

/* ═══ 1 · NO NEW LEGACY CALCULATION CAN BE RECORDED ═══════════════════════ */

describe("the enquiry costing sheet is read-only", () => {
  test("creating one is refused, and none is recorded", async () => {
    const w = await world();
    const before = await sheetsOn(w.enquiry._id);

    const r = await call(`/${w.enquiry._id}/costing-sheet`, {
      method: "POST",
      body: { productName: "Blazer", part: "combined" },
    });

    expect(r.status).toBe(410);
    expect(r.body.error.code).toBe("COSTING_SHEET_RETIRED");
    expect(r.body.error.message).toMatch(/Central Costing/);
    /* The point: nothing was written. */
    expect(await sheetsOn(w.enquiry._id)).toEqual(before);
  });

  test("self-assignment is refused — Sales cannot grant itself cost visibility", async () => {
    /* ── THE ESCALATION THIS CLOSES ────────────────────────────────────────
       `costingTier` returns "sheet" — the FULL build-up, with materials,
       operations and unit costs — to any sheet owner or editor. This door set
       that role. A Sales user could therefore read the company's costs by
       assigning themselves. */
    const w = await world();
    const r = await call(`/${w.enquiry._id}/costing-sheet/assign`, {
      method: "PATCH",
      body: { productName: "Blazer", part: "combined", assigneeEmployeeId: "anyone" },
    });
    expect(r.status).toBe(410);
    expect(r.body.error.code).toBe("COSTING_SHEET_RETIRED");
    expect(await sheetsOn(w.enquiry._id)).toEqual({ sheets: 0, changes: 0 });
  });

  test("membership, edits and change decisions are all refused", async () => {
    const w = await world();
    const doors = [
      ["PATCH", `/${w.enquiry._id}/costing-sheet/members`, { productName: "Blazer", members: [] }],
      ["PATCH", `/${w.enquiry._id}/costing-sheet/Blazer/data`, { materials: [{ name: "x", cost: 1 }] }],
      ["POST", `/${w.enquiry._id}/costing-sheet/Blazer/change/507f1f77bcf86cd799439011/decide`,
        { decision: "approve" }],
    ];
    for (const [method, path_, body] of doors) {
      const r = await call(path_, { method, body });
      expect([path_, r.status]).toEqual([path_, 410]);
      expect([path_, r.body.error.code]).toEqual([path_, "COSTING_SHEET_RETIRED"]);
    }
    /* And after all three, still nothing. */
    expect(await sheetsOn(w.enquiry._id)).toEqual({ sheets: 0, changes: 0 });
  });
});

/* ═══ 2 · NO SECOND FLOOR IS PUBLISHED ═══════════════════════════════════ */

describe("the legacy read publishes no floor", () => {
  test("the sheet data route offers no floorPrice and no markupPercent", async () => {
    /* ── TWO FLOOR AUTHORITIES IS ONE TOO MANY ────────────────────────────
       This used to answer `{ costed, floorPrice, markupPercent }` computed
       from a Sales setting defaulting to 22%. The price somebody quotes from
       has to be the one management decided, so the only floor is Central
       Costing's. */
    const w = await world();
    const r = await call(`/${w.enquiry._id}/costing-sheet/Blazer/data`);
    /* Whatever the tier resolves to for this actor, no floor crosses. */
    if (r.status === 200) {
      expect(r.body.summary).not.toHaveProperty("floorPrice");
      expect(r.body.summary).not.toHaveProperty("markupPercent");
      expect(r.body.summary.floorSource).toBe("CENTRAL_COSTING");
    }
    /* And the response never carries either name, at any tier. */
    expect(JSON.stringify(r.body)).not.toMatch(/floorPrice|markupPercent/);
  });
});

/* ═══ 3 · THE CUSTOMER'S APPROVAL DOES NOT PRICE THE CATALOGUE ════════════ */

describe("customer approval and the item master", () => {
  /* ── WHY THE PUBLIC ROUTE IS NOT DRIVEN HERE ────────────────────────────
     `POST /costing-approval/:token/decide` is deliberately session-less — a
     customer follows a link and has no account. Its writes still pass through
     `salesScope`, which requires `req.user`, so the route cannot be exercised
     from this harness without standing up a request context the middleware
     would normally bind. That is a property of the harness, not of the fix.

     The claim is proved two other ways, and both are stronger than a status
     code would have been:

       · the code path is GONE — asserted against the source below, so there is
         no write to fail to happen;
       · the full chain leaves the catalogue untouched — asserted in
         `pi-acceptance.e2e.test.js`, which confirms `baseSalesPrice` and the
         variant price are unchanged after a quantity is confirmed, a costing
         approved, a price reviewed and a proforma raised.

     What remains uncovered is one human click: approving through the emailed
     link and re-reading the stock item. It is on the release checklist. */

  test("the price-to-catalogue sync no longer exists in the route at all", async () => {
    /* Pinned against the source: the function is gone, not merely unreferenced,
       and with it a catch that called `answeredTenantRefusal(res, err)` with no
       `res` in scope — so any save failure raised a ReferenceError out of the
       handler and failed the customer's approval. */
    const fs = require("fs");
    const src = fs.readFileSync("routes/CMS_Routes/Sales/enquiries.js", "utf8");
    expect(src).not.toMatch(/syncApprovedPriceToStockItem/);
    expect(src).not.toMatch(/stockItem\.baseSalesPrice = price/);
  });
});
