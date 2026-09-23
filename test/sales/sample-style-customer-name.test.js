// test/sales/sample-style-customer-name.test.js
//
// THE NOTIFICATION HELPER THAT COULD NOT RUN.
//
// `customerNameFor(style)` in the sample-style router did a company-scoped
// account lookup — `Account.findOne(await scoped(req, …))` — inside a function
// that took no `req` and had none in scope. Every call that got past the two
// guards above it reached a ReferenceError.
//
// ── AND NOTHING SAID SO ─────────────────────────────────────────────────────
// All six callers are fire-and-forget notification blocks:
//
//     (async () => { … await notifyEvent(…) })().catch(() => {});
//
// so the throw was caught and discarded, the route answered 200, and the email
// simply never arrived. A route's status code proves nothing about this helper,
// which is why this file does not assert one: it captures what actually
// reached `notifyEvent`, and fails the test if nothing did.
//
// The two guards are why it survived at all. A house sample returns before the
// lookup, and so does a style with no account — so the only styles that reached
// the defect were journey-linked ones with a real customer, which is every
// style that matters and none of the fixtures anybody had written.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

jest.mock("../../Middlewear/SalesAuthMiddlewear", () => {
  const jwtLib = require("jsonwebtoken");
  const mw = (req, res, next) => {
    const header = req.headers.authorization || "";
    if (!header.startsWith("Bearer ")) {
      return res.status(401).json({ success: false, message: "Authentication required." });
    }
    try {
      req.user = jwtLib.verify(header.slice(7), process.env.JWT_SECRET || "grav_clothing_secret_key");
      next();
    } catch {
      res.status(401).json({ success: false, message: "Invalid token." });
    }
  };
  mw.withRoles = () => mw;
  mw.RND_ROLES = [];
  return mw;
});

/**
 * The one seam that makes the bug observable.
 *
 * The real service is best-effort and swallows everything. This records each
 * call and resolves a waiter, so a test can await the fire-and-forget block
 * rather than racing it — and can tell "the email said —" apart from "the
 * email never happened", which is exactly the distinction the defect hid.
 */
/* `mock`-prefixed, which is the only name a jest factory may close over. */
const mockNotifications = [];
const mockWaiter = { resolve: null };
jest.mock("../../services/departmentNotify.service", () => ({
  APP_URL: "http://test.local",
  notifyEvent: jest.fn(async (event, ctx) => {
    mockNotifications.push({ event, ctx });
    if (mockWaiter.resolve) { const r = mockWaiter.resolve; mockWaiter.resolve = null; r(); }
    return { sent: ["someone@grav.test"] };
  }),
}));

/** Wait for the next notification, or fail loudly rather than time out. */
function nextNotification({ within = 4000 } = {}) {
  const last = () => mockNotifications[mockNotifications.length - 1];
  if (mockNotifications.length) return Promise.resolve(last());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      mockWaiter.resolve = null;
      /* THE FAILURE THE DEFECT PRODUCED. The route answered 202 and the block
         threw into its own `.catch`, so nothing was ever sent. */
      reject(new Error("No notification was sent — the notification block threw and was swallowed."));
    }, within);
    mockWaiter.resolve = () => { clearTimeout(timer); resolve(last()); };
  });
}

const Employee = require("../../models/Employee");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DeptUser = require("../../models/Access/DeptUser");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");
const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
const Account = require("../../models/CMS_Models/Sales/Account");
const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  /* `customerNameFor` is a helper of the SALES sample-style router, reached
     through Sales' own `/materials` door. It was written under this suite
     while Merchandising's endpoints still shared that file; they have since
     moved to routes/CMS_Routes/Merchandising/styleRoute.js and this file did
     not follow them, because its subject never belonged to Merchandising. */
  app.use("/api/cms/crm/sample-styles", require("../../routes/CMS_Routes/Sales/sampleStyles"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/crm/sample-styles`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });
beforeEach(() => { mockNotifications.length = 0; mockWaiter.resolve = null; });

const call = (path, { token, method = "GET", body } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

/**
 * A company, a merchandiser who is NOT a Sales bypass, and a style.
 *
 * The materials route stages a change for anybody without `bypassesApproval`,
 * and staging is what fires `materials_change_requested`. That is the shortest
 * real path to the helper.
 */
async function world({ withAccount = true, sampleType = "journey", label = "Cust" } = {}) {
  const n = ++seq;
  const co = await Acc_Company.create({
    companyName: `${label} ${n}`, booksFromDate: new Date("2026-04-01"),
  });
  const account = withAccount
    ? await Account.create({
      companyId: co._id, companyName: `Northwind Apparel ${n}`, status: "active",
    })
    : null;
  const journey = await SalesJourney.create({
    journeyId: `SJ-${label}-${n}`, companyId: co._id, name: `J${n}`,
    accountId: account ? account._id : new mongoose.Types.ObjectId(),
    ownerId: new mongoose.Types.ObjectId(), ownerName: "O",
  });
  /* A house sample has no journey, so its company is proved through an
     enquiry — without one it is attributable to nobody and the route answers
     404 before any notification is composed. */
  const enquiry = await Enquiry.create({
    enquiryId: `ENQ-${label}-${n}`, journeyId: journey._id,
    accountId: account ? account._id : new mongoose.Types.ObjectId(),
    companyId: co._id, title: `Enquiry ${n}`, isActive: true,
    products: [{ product: `${label} tee`, quantity: 500 }],
  });
  const style = await SampleStyle.create({
    sampleStyleId: `SS-${label}-${n}`, styleCode: `SC-${label}-${n}`,
    productName: `${label} tee`, sampleType,
    ...(sampleType === "house" ? {} : { journeyId: journey._id }),
    enquiryId: enquiry._id,
    ...(account ? { accountId: account._id } : {}),
    stage: "materials", materials: { status: "pending", rawItems: [] },
  });

  const email = `cn${n}@grav.test`;
  const emp = await Employee.create({
    firstName: "C", lastName: `N${n}`, email, biometricId: `CN${n}`,
    isActive: true, gender: "Other", department: "Merch",
  });
  await DeptUser.create({
    name: "User", email, passwordHash: "x", isAdmin: false, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  await SpCompanyMembership.create({
    companyId: co._id, email, employeeRef: emp._id, personName: "C",
  });

  return {
    co, account, style, enquiry,
    /* `role: "employee"` on purpose: a Sales/admin/CEO token would take the
       direct-apply branch, which sends no notification at all. */
    token: jwt.sign(
      { id: String(emp._id), email, name: "C N", role: "employee", employeeId: emp.biometricId },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
    ),
  };
}

/** Stage a materials change, which is what fires the notification. */
const stageMaterials = (w) => call(`/${w.style._id}/materials`, {
  token: w.token, method: "PATCH", body: { items: ["Cotton jersey"] },
});

/** The one detail row the helper feeds. */
const customerLine = (ctx) => (ctx.details || []).find(([k]) => k === "Customer")?.[1];

describe("customerNameFor", () => {
  test("resolves the real customer, which the broken signature never could", async () => {
    const w = await world();

    const res = await stageMaterials(w);
    expect(res.status).toBe(202);              // staged for a Sales decision

    /* The assertion that matters. Before the fix this rejected: the block
       threw a ReferenceError on the undefined `req` and caught it itself. */
    const sent = await nextNotification();
    expect(sent.event).toBe("materials_change_requested");
    expect(customerLine(sent.ctx)).toBe(w.account.companyName);
    expect(sent.ctx.bodyText).toContain(w.account.companyName);
  });

  test("a house sample says so, and never reaches the lookup", async () => {
    const w = await world({ sampleType: "house", withAccount: false, label: "House" });
    await stageMaterials(w);

    const sent = await nextNotification();
    expect(customerLine(sent.ctx)).toBe("In-house sample — no customer");
  });

  test("a style with no account keeps the existing fallback", async () => {
    const w = await world({ withAccount: false, label: "NoAcct" });
    await stageMaterials(w);

    const sent = await nextNotification();
    expect(customerLine(sent.ctx)).toBe("—");
  });

  test("the lookup stays company-scoped — a foreign account is the fallback", async () => {
    /* The reason the helper takes a request at all. It must not be repaired
       by reverting to an unscoped `findById`: a style carrying another
       company's account id would then put that company's customer name into
       an email. It falls through to the same "—" a missing one gets. */
    const mine = await world({ label: "ScopeMine" });
    const theirs = await world({ label: "ScopeTheirs" });

    await SampleStyle.updateOne(
      { _id: mine.style._id }, { $set: { accountId: theirs.account._id } },
    );

    await stageMaterials(mine);
    const sent = await nextNotification();
    expect(customerLine(sent.ctx)).toBe("—");
    expect(JSON.stringify(sent.ctx)).not.toContain(theirs.account.companyName);
  });
});

describe("the contract, across the whole file", () => {
  const src = require("fs").readFileSync(
    require("path").join(__dirname, "../../routes/CMS_Routes/Sales/sampleStyles.js"), "utf8",
  );

  test("the helper takes a request, and every caller supplies one", () => {
    expect(src).toMatch(/async function customerNameFor\(style, req\)/);
    const calls = src.match(/customerNameFor\([^)]*\)/g) || [];
    /* The declaration plus its callers — six of them, not only the
       material-change path that surfaced the defect. */
    expect(calls).toHaveLength(7);
    for (const c of calls) expect(c).toBe("customerNameFor(style, req)");
  });

  test("the account lookup is still scoped, not reverted to findById", () => {
    const i = src.indexOf("async function customerNameFor(style, req)");
    const body = src.slice(i, src.indexOf("\n}", i));
    expect(body).toMatch(/Account\.findOne\(await scoped\(req, \{ _id: style\.accountId \}\)\)/);
    expect(body).not.toMatch(/findById/);
    /* And the two early returns that keep house samples and account-less
       styles away from the lookup entirely. */
    expect(body).toMatch(/sampleType === "house"/);
    expect(body).toMatch(/return "—"/);
  });

  test("no top-level helper in the file references a request it was not given", () => {
    /* The defect's class, not just its instance. */
    const re = /^(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)\s*\{/gm;
    const offenders = [];
    let m;
    while ((m = re.exec(src))) {
      const [full, name, params] = m;
      let i = m.index + full.length;
      let depth = 1;
      while (i < src.length && depth > 0) {
        const c = src[i];
        if (c === "{") depth += 1; else if (c === "}") depth -= 1;
        i += 1;
      }
      const body = src.slice(m.index + full.length, i - 1)
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
      const takesReq = /\breq\b/.test(params);
      const usesReq = /\breq\b/.test(body);
      /* A nested function or arrow that declares its own `req` supplies it. */
      const suppliesOwn = /\(\s*req\b|\breq\s*=>/.test(body);
      if (usesReq && !takesReq && !suppliesOwn) offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });
});
