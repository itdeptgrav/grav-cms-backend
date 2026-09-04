// test/accountant/service-budget-head.route.test.js
//
// WHICH BUDGET HEAD A BOUGHT SERVICE NORMALLY CONSUMES — over HTTP.
//
// ── THE ONE RULE THIS FILE EXISTS FOR ───────────────────────────────────────
// A service resolves from the Service Master's own `budgetLedgerId` and from
// NOTHING else. It has a `category` field that looks exactly like an item's,
// and the Item Category mappings sit one function call away. If a service
// called "Consultancy" ever inherited the head somebody mapped for the
// consumables category, professional fees would be charged to a materials
// budget and it would look entirely deliberate on the report. Several tests
// below exist only to prove that fall-through does not happen.
//
// ── AND ONE BOUNDARY ────────────────────────────────────────────────────────
// Setting a default is a suggested classification for FUTURE service requests.
// It is not an approval, a commitment, a posting, a price or permission to
// exceed anything. The last test walks the collections and proves that saving
// one writes no commitment, voucher, purchase order, service order or stock
// record.
"use strict";

const express = require("express");
const mongoose = require("mongoose");

jest.mock("../../Middlewear/AccountantAuthMiddleware", () => ({
  accountantAuth: (req, res, next) => {
    const raw = req.headers["x-test-user"];
    if (!raw) return res.status(401).json({ error: "Authentication required." });
    req.user = JSON.parse(raw);
    next();
  },
}));
jest.mock("../../Middlewear/AccountantOrgAuthMiddleware", () => ({
  orgAuth: (req, res, next) => {
    const raw = req.headers["x-test-user"];
    if (!raw) return res.status(401).json({ error: "Authentication required." });
    req.user = JSON.parse(raw);
    next();
  },
  requireRole: () => (req, res, next) => next(),
  requirePermission: () => (req, res, next) => next(),
}));

const { Acc_Company, Acc_Group, Acc_Ledger } = require("../../models/Accountant_model/Acc_MasterModels");
const Service = require("../../models/CMS_Models/Inventory/Services/Service");
const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const ItemCategoryBudget = require("../../models/Accountant_model/Acc_ItemCategoryBudget");

let server, base, seq = 0;

const financeOf = (companyId) => ({
  id: new mongoose.Types.ObjectId().toString(),
  name: "Priya Owner",
  role: "owner",
  companyId: String(companyId),
  permissions: { canEdit: true, canApprove: true },
});
/* May enter vouchers; may not decide what a service spends out of. */
const editorOf = (companyId) => ({
  id: new mongoose.Types.ObjectId().toString(),
  name: "Sam Editor",
  role: "editor",
  companyId: String(companyId),
  permissions: { canEdit: true },
});

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/accountant/chart-of-accounts",
    require("../../routes/Accountant_Routes/Acc_chartOfAccounts"),
  );
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/accountant/chart-of-accounts`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

async function call(path, { method = "GET", body, user } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(user ? { "x-test-user": JSON.stringify(user) } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** A company with the four head shapes the classification distinguishes. */
async function seedCompany() {
  seq += 1;
  const company = await Acc_Company.create({
    companyName: `Service Co ${seq}`,
    booksFromDate: new Date("2026-04-01"),
  });
  const expGroup = await Acc_Group.create({
    companyId: company._id, name: `Indirect Expenses ${seq}`, nature: "expense",
  });
  const bankGroup = await Acc_Group.create({
    companyId: company._id, name: `Bank Accounts ${seq}`, nature: "asset",
  });
  const revGroup = await Acc_Group.create({
    companyId: company._id, name: `Sales Accounts ${seq}`, nature: "revenue",
  });
  /* ── A GROUP WITH NO NATURE ─────────────────────────────────────────────
     `nature` is required by the schema, so this cannot be created through
     Mongoose — which is exactly why such rows exist: they arrive from
     imports and direct writes that never went through it. Unset at the
     driver level to reproduce that shape faithfully. A ledger hanging off
     it cannot be classified and must be refused, not assumed to be spend. */
  const blankGroup = await Acc_Group.create({
    companyId: company._id, name: `Imported ${seq}`, nature: "expense",
  });
  await Acc_Group.collection.updateOne(
    { _id: blankGroup._id }, { $unset: { nature: "" } },
  );
  blankGroup.nature = undefined;

  /* `nature` is required on a ledger too, so a "natureless" LEDGER is not a
     representable state — the gap this contract has to survive is a missing
     nature on the GROUP it derives from. */
  const mk = (name, group) => Acc_Ledger.create({
    companyId: company._id, name: `${name} ${seq}`,
    groupId: group._id, groupName: group.name, nature: group.nature || "expense",
  });

  return {
    company,
    spendHead: await mk("Repairs & Maintenance", expGroup),
    otherHead: await mk("Software Subscriptions", expGroup),
    bank: await mk("HDFC Current", bankGroup),
    revenueHead: await mk("Domestic Sales", revGroup),
    /* Expense-natured and still not a budget head — the case a bare
       `nature === "expense"` check accepts and this contract refuses. */
    roundOff: await Acc_Ledger.create({
      companyId: company._id, name: "Round Off",
      groupId: expGroup._id, groupName: expGroup.name, nature: "expense",
    }),
    natureless: await mk("Unclassified Import", blankGroup),
    finance: financeOf(company._id),
  };
}

const mkService = (company, over = {}) => Service.create({
  companyId: company._id,
  serviceCode: `SVC/2026-27/${String(++seq).padStart(4, "0")}`,
  name: over.name || `Service ${seq}`,
  ...over,
});

const setHead = (company, service, budgetLedgerId, user) =>
  call(`/services/${service._id}/budget-head`, {
    method: "PUT",
    user: user || financeOf(company._id),
    body: { companyId: String(company._id), budgetLedgerId },
  });

const resolve = (company, serviceIds, user) =>
  call(`/service-budget-heads/resolve`, {
    method: "POST",
    user: user || financeOf(company._id),
    body: { companyId: String(company._id), serviceIds },
  });

/* ══ 1 & 2 — RESOLUTION ═════════════════════════════════════════════════════ */

describe("what a service resolves to", () => {
  test("a configured service resolves with source service_default", async () => {
    const { company, spendHead, finance } = await seedCompany();
    const service = await mkService(company, { name: "Lift AMC" });

    const set = await setHead(company, service, String(spendHead._id));
    expect(set.status).toBe(200);

    const { body } = await resolve(company, [String(service._id)], finance);
    expect(body.results).toHaveLength(1);
    expect(body.results[0].source).toBe("service_default");
    expect(String(body.results[0].budgetLedgerId)).toBe(String(spendHead._id));
    expect(body.results[0].budgetLedgerName).toBe(spendHead.name);
  });

  test("an unconfigured service resolves as unresolved, not as an error", async () => {
    const { company, finance } = await seedCompany();
    const service = await mkService(company, { name: "Pest control" });

    const { status, body } = await resolve(company, [String(service._id)], finance);

    expect(status).toBe(200);
    expect(body.results[0].found).toBe(true);
    expect(body.results[0].source).toBe("unresolved");
    expect(body.results[0].budgetLedgerId).toBeNull();
    expect(body.results[0].budgetLedgerName).toBeNull();
  });

  test("the name snapshot is stored, not resolved at read time", async () => {
    const { company, spendHead } = await seedCompany();
    const service = await mkService(company, { name: "Lift AMC" });
    await setHead(company, service, String(spendHead._id));

    const stored = await Service.findById(service._id).lean();
    expect(stored.budgetLedgerName).toBe(spendHead.name);
    expect(String(stored.budgetLedgerId)).toBe(String(spendHead._id));
  });

  test("who set the default and when are recorded", async () => {
    const { company, spendHead } = await seedCompany();
    const service = await mkService(company, { name: "Lift AMC" });
    await setHead(company, service, String(spendHead._id));

    const stored = await Service.findById(service._id).lean();
    /* The Service Master's general `updatedBy` moves whenever anyone edits the
       billing unit; it cannot answer "who classified this". */
    expect(stored.budgetLedgerSetByName).toBe("Priya Owner");
    expect(stored.budgetLedgerSetAt).toBeInstanceOf(Date);
  });
});

/* ══ 3 — NO ITEM-CATEGORY FALL-THROUGH ══════════════════════════════════════ */

describe("a service never borrows an item category's head", () => {
  test("a mapped category with the same name does not resolve the service", async () => {
    const { company, spendHead, finance } = await seedCompany();

    /* Finance maps the item category "Facilities" to a real budget head. */
    const mapped = await call(`/item-categories/Facilities`, {
      method: "PUT", user: finance,
      body: { companyId: String(company._id), budgetLedgerId: String(spendHead._id) },
    });
    expect(mapped.status).toBe(200);

    /* A service in a category spelled exactly the same, with no default. */
    const service = await mkService(company, { name: "Lift AMC", category: "Facilities" });

    const { body } = await resolve(company, [String(service._id)], finance);

    /* Item categories describe what the STORE STOCKS. Inheriting one here
       would charge a maintenance contract to a materials budget.

       NOTE ON WHAT THIS PROVES: this is an end-to-end outcome, not the guard.
       Neutralising `headForService` to consult a map leaves this test GREEN,
       because the service path never builds a map to hand it. The two tests
       below are the actual proof — one behavioural, one structural. */
    expect(body.results[0].source).toBe("unresolved");
    expect(body.results[0].budgetLedgerId).toBeNull();
    /* And the category is named in the message, so a reader can see it was
       considered and deliberately not used rather than wonder if it was missed. */
    expect(body.results[0].message).toMatch(/Facilities/);
  });

  test("the pure resolver ignores a category map even when handed one", () => {
    const svc = require("../../services/itemBudgetHead.service");
    const map = new Map([["facilities", {
      budgetLedgerId: "aaaaaaaaaaaaaaaaaaaaaaaa",
      budgetLedgerName: "Raw Materials",
      category: "Facilities",
    }]]);
    const subject = { category: "Facilities" };

    /* Side by side, on the SAME map and the SAME category. This is the whole
       rule: an item takes the mapping, a service does not.

       (Arity is not the proof — both functions declare defaulted parameters,
        so `Function.length` is 0 for each and an assertion on it passes
        whatever the body does. An earlier version of this test asserted
        exactly that and proved nothing.) */
    const asItem = svc.headForItem(subject, map);
    expect(asItem.source).toBe("category_mapping");
    expect(asItem.budgetLedgerId).toBe("aaaaaaaaaaaaaaaaaaaaaaaa");

    const asService = svc.headForService(subject, map);
    expect(asService.source).toBe("unresolved");
    expect(asService.budgetLedgerId).toBeNull();
  });

  test("the service path never builds a category map at all", async () => {
    const svc = require("../../services/itemBudgetHead.service");
    const source = require("fs").readFileSync(
      require("path").join(__dirname, "../../services/itemBudgetHead.service.js"), "utf8",
    );

    /* The body of `resolveServiceIds`, isolated from the file around it. */
    const start = source.indexOf("async function resolveServiceIds");
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf("\n}", start));

    /* It must not reach for the item machinery — not `categoryMap`, not
       `headForItem`. A map that is never constructed cannot be consulted,
       which is the guarantee the behavioural test above cannot make. */
    expect(body).not.toMatch(/categoryMap/);
    expect(body).not.toMatch(/headForItem/);
    expect(body).toMatch(/headForService/);

    /* And the resolver itself reads only `budgetLedgerId` — proven by giving
       it a service whose every OTHER field is populated. */
    const r = svc.headForService({
      category: "Facilities", sacCode: "998719", defaultGstRate: 18,
      preferredVendorName: "Otis", billingUnit: "Per month", defaultRate: 4500,
    });
    expect(r.source).toBe("unresolved");
  });

  test("nothing is inferred from supplier, SAC or GST", async () => {
    const { company, finance } = await seedCompany();
    const service = await mkService(company, {
      name: "Courier retainer",
      category: "Logistics",
      sacCode: "996812",
      defaultGstRate: 18,
      preferredVendorName: "VRL Logistics",
    });

    const { body } = await resolve(company, [String(service._id)], finance);

    /* A supplier sells more than one kind of thing, a SAC code is a tax
       classification and a GST rate is a percentage. None is evidence about
       which envelope the money leaves. */
    expect(body.results[0].source).toBe("unresolved");
    expect(body.results[0].budgetLedgerId).toBeNull();
  });

  test("item resolution is unchanged by any of this", async () => {
    const { company, spendHead, finance } = await seedCompany();
    await call(`/item-categories/Fabric`, {
      method: "PUT", user: finance,
      body: { companyId: String(company._id), budgetLedgerId: String(spendHead._id) },
    });
    const item = await RawItem.create({
      name: `Cotton ${++seq}`, sku: `SKU${seq}`, category: "Fabric", unit: "pcs",
    });

    const { body } = await call(`/item-budget-heads/resolve`, {
      method: "POST", user: finance,
      body: { companyId: String(company._id), itemIds: [String(item._id)] },
    });

    expect(body.results[0].source).toBe("category_mapping");
    expect(String(body.results[0].budgetLedgerId)).toBe(String(spendHead._id));
  });
});

/* ══ 4 & 5 — BULK RESOLUTION AND THE COMPANY BOUNDARY ═══════════════════════ */

describe("bulk resolution answers for every id asked about", () => {
  test("one row per requested id, in all three flavours", async () => {
    const { company, spendHead, finance } = await seedCompany();
    const configured = await mkService(company, { name: "Lift AMC" });
    const bare = await mkService(company, { name: "Pest control" });
    await setHead(company, configured, String(spendHead._id));
    const absent = new mongoose.Types.ObjectId().toString();

    const ids = [String(configured._id), String(bare._id), absent];
    const { body } = await resolve(company, ids, finance);

    /* Returning two rows for three ids would make a missing service look like
       a resolution result. */
    expect(body.results).toHaveLength(3);
    expect(body.results.map((r) => r.serviceId)).toEqual(ids);
    expect(body.results.map((r) => [r.found, r.source])).toEqual([
      [true, "service_default"],
      [true, "unresolved"],
      [false, "unresolved"],
    ]);
  });

  test("a malformed id gets a row rather than failing the whole batch", async () => {
    const { company, finance } = await seedCompany();
    const real = await mkService(company, { name: "Lift AMC" });

    const { status, body } = await resolve(company, ["not-an-id", String(real._id)], finance);

    /* A CastError on one id would throw for the query and lose the valid
       ones with it. */
    expect(status).toBe(200);
    expect(body.results).toHaveLength(2);
    expect(body.results[0].found).toBe(false);
    expect(body.results[1].found).toBe(true);
  });

  test("an empty list is refused rather than answered with nothing", async () => {
    const { company, finance } = await seedCompany();
    const { status } = await resolve(company, [], finance);
    expect(status).toBe(400);
  });

  test("another company's service is not found, and leaks nothing", async () => {
    const mine = await seedCompany();
    const theirs = await seedCompany();
    const secret = await mkService(theirs.company, {
      name: "Confidential Retainer",
      category: "Legal",
      billingUnit: "Per month",
      budgetLedgerName: "Their Legal Budget",
    });

    const { body } = await resolve(mine.company, [String(secret._id)], mine.finance);

    const row = body.results[0];
    expect(row.found).toBe(false);
    /* Identical to a genuinely absent id. Saying "exists, but not yours"
       confirms that the other company holds that record. */
    expect(row.message).toMatch(/No service with this id/i);

    const serialised = JSON.stringify(row);
    for (const leak of ["Confidential Retainer", "Legal", "Per month", "Their Legal Budget"]) {
      expect(serialised).not.toContain(leak);
    }
  });

  test("another company's service cannot be reconfigured through this company", async () => {
    const mine = await seedCompany();
    const theirs = await seedCompany();
    const target = await mkService(theirs.company, { name: "Their AMC" });

    const res = await call(`/services/${target._id}/budget-head`, {
      method: "PUT", user: mine.finance,
      body: { companyId: String(mine.company._id), budgetLedgerId: String(mine.spendHead._id) },
    });

    expect(res.status).toBe(404);
    const after = await Service.findById(target._id).lean();
    expect(after.budgetLedgerId).toBeNull();
  });

  test("a body-supplied company that disagrees with the session is refused", async () => {
    const mine = await seedCompany();
    const theirs = await seedCompany();
    const service = await mkService(theirs.company, { name: "Their AMC" });

    const res = await call(`/services/${service._id}/budget-head`, {
      method: "PUT", user: mine.finance,
      /* The session says one company, the body says another. */
      body: { companyId: String(theirs.company._id), budgetLedgerId: null },
    });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not yours/i);
  });
});

/* ══ 6, 7 & 8 — WHICH HEADS MAY BE ASSIGNED ════════════════════════════════ */

describe("the head a service may be pointed at", () => {
  test("another company's ledger is refused", async () => {
    const mine = await seedCompany();
    const theirs = await seedCompany();
    const service = await mkService(mine.company, { name: "Lift AMC" });

    const res = await setHead(mine.company, service, String(theirs.spendHead._id));

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/does not exist/i);
    const after = await Service.findById(service._id).lean();
    expect(after.budgetLedgerId).toBeNull();
  });

  test("a non-expense head is refused", async () => {
    const { company, bank } = await seedCompany();
    const service = await mkService(company, { name: "Lift AMC" });

    const res = await setHead(company, service, String(bank._id));

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not a budget head/i);
  });

  test("a revenue target is refused and named as one", async () => {
    const { company, revenueHead } = await seedCompany();
    const service = await mkService(company, { name: "Lift AMC" });

    const res = await setHead(company, service, String(revenueHead._id));

    expect(res.status).toBe(400);
    /* A figure to hit, not an envelope to spend from. */
    expect(res.body.message).toMatch(/revenue target/i);
  });

  test("an expense-natured head nobody budgets is refused", async () => {
    const { company, roundOff } = await seedCompany();
    const service = await mkService(company, { name: "Lift AMC" });

    /* Round Off IS an expense. Asking `nature === "expense"` accepts it. */
    const res = await setHead(company, service, String(roundOff._id));

    expect(res.status).toBe(400);
  });

  test("a head with no recorded nature is refused, not assumed", async () => {
    const { company, natureless } = await seedCompany();
    const service = await mkService(company, { name: "Lift AMC" });

    const res = await setHead(company, service, String(natureless._id));

    expect(res.status).toBe(400);
    /* Named separately from "not a budget head": that reads as a policy
       decision, this is a gap in the chart somebody can go and fix. */
    expect(res.body.message).toMatch(/no recorded nature/i);
    const after = await Service.findById(service._id).lean();
    expect(after.budgetLedgerId).toBeNull();
  });

  test("a malformed ledger id is refused, not a 500", async () => {
    const { company } = await seedCompany();
    const service = await mkService(company, { name: "Lift AMC" });

    const res = await setHead(company, service, "not-an-id");

    expect(res.status).toBe(400);
  });

  test("the Service Master and Finance accept exactly the same heads", async () => {
    /* Two gates for one question is how a service ends up carrying a head
       that Finance's own screen would refuse. */
    const svc = require("../../services/itemBudgetHead.service");
    const storeRoute = require("fs").readFileSync(
      require("path").join(__dirname, "../../routes/CMS_Routes/Inventory/Services/services.js"),
      "utf8",
    );
    expect(storeRoute).toMatch(/assertMappable/);
    expect(storeRoute).not.toMatch(/nature !== "expense"/);
    expect(typeof svc.assertMappable).toBe("function");
  });

  test("only Finance may set a default", async () => {
    const { company, spendHead } = await seedCompany();
    const service = await mkService(company, { name: "Lift AMC" });

    const res = await setHead(company, service, String(spendHead._id), editorOf(company._id));

    expect(res.status).toBe(403);
    const after = await Service.findById(service._id).lean();
    expect(after.budgetLedgerId).toBeNull();
  });
});

/* ══ 9 — CLEARING ══════════════════════════════════════════════════════════ */

describe("clearing a default", () => {
  test("removes the id AND the name together", async () => {
    const { company, spendHead } = await seedCompany();
    const service = await mkService(company, { name: "Lift AMC" });
    await setHead(company, service, String(spendHead._id));

    const cleared = await setHead(company, service, null);
    expect(cleared.status).toBe(200);

    const after = await Service.findById(service._id).lean();
    expect(after.budgetLedgerId).toBeNull();
    /* A stale name behind a null id is how a screen shows a head that
       nothing resolves to any more. */
    expect(after.budgetLedgerName).toBe("");
  });

  test("a cleared service resolves as unresolved again", async () => {
    const { company, spendHead, finance } = await seedCompany();
    const service = await mkService(company, { name: "Lift AMC" });
    await setHead(company, service, String(spendHead._id));
    await setHead(company, service, null);

    const { body } = await resolve(company, [String(service._id)], finance);
    expect(body.results[0].source).toBe("unresolved");
  });
});

/* ══ 11 — INACTIVE SERVICES ════════════════════════════════════════════════ */

describe("Finance can still read a retired service", () => {
  test("an inactive service is listed and labelled, not hidden", async () => {
    const { company, spendHead, finance } = await seedCompany();
    const retired = await mkService(company, { name: "Old Courier Retainer", status: "INACTIVE" });
    await Service.updateOne({ _id: retired._id }, {
      $set: { budgetLedgerId: spendHead._id, budgetLedgerName: spendHead.name },
    });

    const { body } = await call(
      `/service-budget-heads/services?companyId=${company._id}`, { user: finance },
    );

    const row = body.services.find((s) => String(s._id) === String(retired._id));
    /* A classification made last year has to stay understandable. */
    expect(row).toBeTruthy();
    expect(row.status).toBe("INACTIVE");
    expect(row.resolution.source).toBe("service_default");
  });

  test("an inactive service still resolves", async () => {
    const { company, spendHead, finance } = await seedCompany();
    const retired = await mkService(company, {
      name: "Old AMC", status: "INACTIVE",
      budgetLedgerId: spendHead._id, budgetLedgerName: spendHead.name,
    });

    const { body } = await resolve(company, [String(retired._id)], finance);
    expect(body.results[0].source).toBe("service_default");
    expect(body.results[0].status).toBe("INACTIVE");
  });

  test("this screen cannot reactivate a service", async () => {
    const { company, spendHead } = await seedCompany();
    const retired = await mkService(company, { name: "Old AMC", status: "INACTIVE" });

    await setHead(company, retired, String(spendHead._id));

    /* Setting a budget default is a Finance decision. Putting a service back
       into circulation is the Store's, and this route must not do it as a
       side effect. */
    const after = await Service.findById(retired._id).lean();
    expect(after.status).toBe("INACTIVE");
  });

  test("the list can be filtered, and by default shows both", async () => {
    const { company, finance } = await seedCompany();
    await mkService(company, { name: "AAA Active One" });
    await mkService(company, { name: "AAA Retired One", status: "INACTIVE" });

    const all = await call(
      `/service-budget-heads/services?companyId=${company._id}&search=AAA`, { user: finance });
    const active = await call(
      `/service-budget-heads/services?companyId=${company._id}&search=AAA&status=ACTIVE`,
      { user: finance });

    /* An unstated status must not quietly mean ACTIVE — Finance needs the
       retired ones visible here. */
    expect(all.body.services).toHaveLength(2);
    expect(active.body.services).toHaveLength(1);
  });
});

/* ══ THE LIST ══════════════════════════════════════════════════════════════ */

describe("finding a service", () => {
  test("searchable by name and by code, scoped to this company", async () => {
    const mine = await seedCompany();
    const theirs = await seedCompany();
    const service = await mkService(mine.company, { name: "Lift Maintenance" });
    await mkService(theirs.company, { name: "Lift Maintenance" });

    const byName = await call(
      `/service-budget-heads/services?companyId=${mine.company._id}&search=Lift`,
      { user: mine.finance });
    const byCode = await call(
      `/service-budget-heads/services?companyId=${mine.company._id}&search=${encodeURIComponent(service.serviceCode)}`,
      { user: mine.finance });

    expect(byName.body.services).toHaveLength(1);
    expect(String(byName.body.services[0]._id)).toBe(String(service._id));
    expect(byCode.body.services).toHaveLength(1);
  });

  test("a search term is text, not a pattern", async () => {
    const { company, finance } = await seedCompany();
    await mkService(company, { name: "Lift AMC" });

    const hit = await call(
      `/service-budget-heads/services?companyId=${company._id}&search=${encodeURIComponent(".*")}`,
      { user: finance });

    expect(hit.status).toBe(200);
    expect(hit.body.services).toHaveLength(0);
  });

  test("coverage counts the company, not the page", async () => {
    const { company, spendHead, finance } = await seedCompany();
    const a = await mkService(company, { name: "Zeta One" });
    await mkService(company, { name: "Zeta Two" });
    await setHead(company, a, String(spendHead._id));

    const filtered = await call(
      `/service-budget-heads/services?companyId=${company._id}&search=Zeta One`,
      { user: finance });

    /* A coverage figure that changes when you type in the search box is not
       a coverage figure. */
    expect(filtered.body.services).toHaveLength(1);
    expect(filtered.body.coverage).toEqual({ total: 2, resolved: 1, unresolved: 1 });
  });

  test("unresolved services can be listed on their own", async () => {
    const { company, spendHead, finance } = await seedCompany();
    const done = await mkService(company, { name: "Yankee Done" });
    await mkService(company, { name: "Yankee Todo" });
    await setHead(company, done, String(spendHead._id));

    const { body } = await call(
      `/service-budget-heads/services?companyId=${company._id}&search=Yankee&onlyUnresolved=true`,
      { user: finance });

    expect(body.services.map((s) => s.name)).toEqual(["Yankee Todo"]);
  });

  test("only Finance may read the list", async () => {
    const { company } = await seedCompany();
    const res = await call(
      `/service-budget-heads/services?companyId=${company._id}`,
      { user: editorOf(company._id) });
    expect(res.status).toBe(403);
  });
});

/* ══ 12 — THE BOUNDARY ═════════════════════════════════════════════════════ */

describe("setting a default is a classification and nothing more", () => {
  test("it writes no commitment, voucher, order or stock record", async () => {
    const { company, spendHead } = await seedCompany();
    const service = await mkService(company, { name: "Lift AMC" });

    /* Everything the write could plausibly touch, counted before and after.
       Named explicitly rather than diffed by prefix so a collection that is
       renamed later fails this test loudly instead of dropping out of it. */
    const WATCHED = [
      "acc_budgetcommitments", "acc_vouchers", "acc_budgets", "acc_budgetlines",
      "purchaseorders", "serviceorders", "spendrequests", "intakerequests",
      "stocktransactions", "stockadjustments", "goodsreceipts", "rawitems",
    ];
    const db = mongoose.connection.db;
    const countAll = async () => {
      const out = {};
      for (const name of WATCHED) {
        out[name] = await db.collection(name).countDocuments();
      }
      return out;
    };

    const before = await countAll();
    const res = await setHead(company, service, String(spendHead._id));
    expect(res.status).toBe(200);
    const after = await countAll();

    expect(after).toEqual(before);
  });

  test("the message says it approves nothing and moves no budget", async () => {
    const { company, spendHead } = await seedCompany();
    const service = await mkService(company, { name: "Lift AMC" });

    const res = await setHead(company, service, String(spendHead._id));

    /* A setup screen that reads as live is one people check against a budget
       report that has not changed. */
    expect(res.body.message).toMatch(/approves nothing/i);
    expect(res.body.message).toMatch(/moves no budget/i);
    expect(res.body.message).toMatch(/suggested classification/i);
  });

  test("the ledger's own balance is untouched", async () => {
    const { company, spendHead } = await seedCompany();
    const service = await mkService(company, { name: "Lift AMC" });
    const before = await Acc_Ledger.findById(spendHead._id).lean();

    await setHead(company, service, String(spendHead._id));

    const after = await Acc_Ledger.findById(spendHead._id).lean();
    expect(after.currentBalance).toBe(before.currentBalance);
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
  });

  test("no item-category mapping is created as a side effect", async () => {
    const { company, spendHead } = await seedCompany();
    const service = await mkService(company, { name: "Lift AMC", category: "Facilities" });

    await setHead(company, service, String(spendHead._id));

    /* The service's category is not an item category and must not become one. */
    const mappings = await ItemCategoryBudget.countDocuments({ companyId: company._id });
    expect(mappings).toBe(0);
  });
});
