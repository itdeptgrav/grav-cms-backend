// test/project-manager/manufacturing-order-list.route.test.js
//
// Chunk 3A. The manufacturing-order register, end to end.
//
// The pure suite (mo-list-query.test.js) proves the query rules. This one
// proves they survive the aggregation and the route — that an escaped term
// really does match literally in MongoDB, that a filter really is applied
// before `$facet` so the total counts the filtered set, and that the response
// still carries every field six frontend surfaces read.
//
// The reference date for deadline risk is injected through the service, so the
// risk cases here are as clock-independent as the pure ones.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || "grav_clothing_secret_key";

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
const WorkOrder = require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const { listManufacturingOrders } = require("../../services/manufacturing/moList.service");
const { buildListPipeline } = require("../../services/manufacturing/moListProjection");
const { normaliseListQuery, MAX_PAGE, MAX_LIMIT } = require("../../services/manufacturing/moListQuery");

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-09-03T09:00:00Z");
const inDays = (n) => new Date(NOW.getTime() + n * DAY);

/** Every field the API has published since Chunk 1. A floor, never a ceiling. */
const ROW_FIELDS = [
  "_id", "moNumber", "customerInfo", "finalOrderPrice", "totalQuantity",
  "workOrdersCount", "completedQuantity", "completionPercentage", "status",
  "displayStatus", "priority", "createdAt", "requestType", "measurementName",
  "deliveryDeadline", "estimatedCompletion",
];

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  // server.js:1528-1532, unchanged.
  app.use(
    "/api/cms/manufacturing/manufacturing-orders",
    require("../../routes/CMS_Routes/Manufacturing/Manufacturing-Order/manufacturingOrderRoutes"),
  );
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/manufacturing/manufacturing-orders`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const token = () =>
  jwt.sign(
    { id: String(new mongoose.Types.ObjectId()), email: `pm${++seq}@t.example`, role: "project_manager" },
    process.env.JWT_SECRET, { expiresIn: "10m" },
  );

const call = (qs = "", { auth = true } = {}) =>
  fetch(`${base}${qs}`, { headers: auth ? { Authorization: `Bearer ${token()}` } : {} })
    .then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

/** The same read the route performs, with the clock named. */
const listAt = (query, now = NOW) => listManufacturingOrders(query, { now });

async function mo(over = {}) {
  const n = ++seq;
  const { customerInfo, ...rest } = over;
  return CustomerRequest.create({
    requestId: `REQ-${String(n).padStart(4, "0")}`,
    status: "quotation_sales_approved",
    priority: "medium",
    customerInfo: { name: `Customer ${n}`, email: `c${n}@test.example`, ...customerInfo },
    items: [{ totalQuantity: 10 }],
    ...rest,
  });
}

const wo = (order, over = {}) =>
  WorkOrder.create({
    workOrderNumber: `WO-${++seq}`,
    customerRequestId: order._id,
    quantity: 10,
    ...over,
  });

const numbers = (body) => body.manufacturingOrders.map((r) => r.moNumber);

/* ═══ 1 · WHAT IS IN THE REGISTER ═════════════════════════════════════════ */

describe("scope", () => {
  test("only sales-approved customer requests appear", async () => {
    const approved = await mo();
    await mo({ status: "pending" });
    await mo({ status: "quotation_sent" });
    await mo({ status: "completed" });

    const { body } = await call();
    expect(numbers(body)).toEqual([`MO-${approved.requestId}`]);
    expect(body.pagination.total).toBe(1);
  });

  test("an empty register is a valid empty page, not an error", async () => {
    const { status, body } = await call();
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.manufacturingOrders).toEqual([]);
    expect(body.pagination).toMatchObject({ page: 1, limit: 12, total: 0, pages: 0 });
  });

  test("every established field is still published", async () => {
    await mo({ measurementName: "Chest 40", finalOrderPrice: 5000 });
    const { body } = await call();
    const row = body.manufacturingOrders[0];

    for (const key of ROW_FIELDS) expect(row).toHaveProperty(key);
    expect(row.moNumber).toMatch(/^MO-/);
    expect(row.customerInfo).toHaveProperty("name");
    expect(row.customerInfo).toHaveProperty("email");
  });

  test("the additive fields are additive — nothing was replaced", async () => {
    const deadline = inDays(3);
    await mo({ customerInfo: { deliveryDeadline: deadline }, estimatedCompletion: inDays(20) });
    const { manufacturingOrders: [row] } = await listAt({});

    expect(new Date(row.deliveryDeadline).toISOString()).toBe(deadline.toISOString());
    expect(row.estimatedCompletion).not.toBeNull();
    expect(new Date(row.deadline).toISOString()).toBe(deadline.toISOString());
    expect(row.deadlineRisk).toBe("due_soon");
  });

  test("the response envelope is unchanged", async () => {
    const { body } = await call();
    expect(Object.keys(body).sort()).toEqual(["manufacturingOrders", "pagination", "success"]);
    expect(Object.keys(body.pagination).sort()).toEqual(["limit", "page", "pages", "total"]);
  });
});

/* ═══ 2 · DERIVED FIGURES ═════════════════════════════════════════════════ */

describe("derived figures", () => {
  test("work-order count and quantities come from the work orders", async () => {
    const order = await mo();
    await wo(order, { quantity: 10, productionCompletion: { overallCompletedQuantity: 4 } });
    await wo(order, { quantity: 30, productionCompletion: { overallCompletedQuantity: 2 } });

    const { body } = await call();
    const row = body.manufacturingOrders[0];
    expect(row.workOrdersCount).toBe(2);
    expect(row.completedQuantity).toBe(6);
    expect(row.completionPercentage).toBe(15);   // 6 of 40
  });

  test("completion percentage is finite and bounded to 0-100", async () => {
    const none = await mo();
    const partial = await mo();
    const exact = await mo();
    const over = await mo();

    await wo(partial, { quantity: 10, productionCompletion: { overallCompletedQuantity: 3 } });
    await wo(exact, { quantity: 10, productionCompletion: { overallCompletedQuantity: 10 } });
    // More completed than ordered — a real state after a re-issue. This used to
    // publish 250, which is a broken gauge, not extra information.
    await wo(over, { quantity: 10, productionCompletion: { overallCompletedQuantity: 25 } });

    const { manufacturingOrders } = await listAt({});
    const by = Object.fromEntries(manufacturingOrders.map((r) => [r.moNumber, r]));

    for (const row of manufacturingOrders) {
      expect(Number.isFinite(row.completionPercentage)).toBe(true);
      expect(row.completionPercentage).toBeGreaterThanOrEqual(0);
      expect(row.completionPercentage).toBeLessThanOrEqual(100);
    }

    expect(by[`MO-${none.requestId}`].completionPercentage).toBe(0);      // no work orders, not NaN
    expect(by[`MO-${partial.requestId}`].completionPercentage).toBe(30);  // ordinary ratio, unchanged
    expect(by[`MO-${exact.requestId}`].completionPercentage).toBe(100);
    // The fixture that named this test and was never actually asserted.
    expect(by[`MO-${over.requestId}`].completionPercentage).toBe(100);
    // The units behind it are untouched — only the percentage is bounded.
    expect(by[`MO-${over.requestId}`].completedQuantity).toBe(25);
  });

  test("the bound is in the aggregation, not only in the row mapper", async () => {
    // Read straight off the pipeline, before projectRow runs. Without this the
    // mapper would mask a missing pipeline clamp: the published number would
    // look right while anything filtering or sorting on the aggregated field
    // still saw 250.
    const over = await mo();
    await wo(over, { quantity: 10, productionCompletion: { overallCompletedQuantity: 25 } });

    const [result] = await CustomerRequest.aggregate(
      buildListPipeline(normaliseListQuery({}, NOW)),
    );
    const raw = result.paginated.find((r) => r.requestId === over.requestId);

    expect(raw.completionPercentage).toBe(100);
  });

  test("bounding the percentage does not move the status", async () => {
    // An over-completed order was `completed` before the clamp and must stay
    // `completed` after it: the derivation tests `>= 100`, which 250 and 100
    // both satisfy.
    const over = await mo();
    await wo(over, { quantity: 10, status: "completed", productionCompletion: { overallCompletedQuantity: 25 } });

    const { manufacturingOrders: [row] } = await listAt({});
    expect(row.completionPercentage).toBe(100);
    expect(row.displayStatus).toBe("completed");
    expect(row.status).toBe("completed");
  });

  test("each of the four displayStatus values is produced from real work orders", async () => {
    const pending = await mo();

    const started = await mo();
    await wo(started, { status: "in_progress" });

    const done = await mo();
    await wo(done, { quantity: 10, status: "completed", productionCompletion: { overallCompletedQuantity: 10 } });

    const killed = await mo();
    await wo(killed, { status: "cancelled" });

    const { manufacturingOrders } = await listAt({});
    const by = Object.fromEntries(manufacturingOrders.map((r) => [r.moNumber, r.displayStatus]));

    expect(by[`MO-${pending.requestId}`]).toBe("pending");
    expect(by[`MO-${started.requestId}`]).toBe("in_progress");
    expect(by[`MO-${done.requestId}`]).toBe("completed");
    expect(by[`MO-${killed.requestId}`]).toBe("cancelled");
  });

  test("all-cancelled is not the same answer as no work orders", async () => {
    // Both have nothing in progress; only one was abandoned.
    const empty = await mo();
    const killed = await mo();
    await wo(killed, { status: "cancelled" });
    await wo(killed, { status: "cancelled" });

    const { manufacturingOrders } = await listAt({});
    const by = Object.fromEntries(manufacturingOrders.map((r) => [r.moNumber, r]));

    expect(by[`MO-${empty.requestId}`].displayStatus).toBe("pending");
    expect(by[`MO-${empty.requestId}`].workOrdersCount).toBe(0);
    expect(by[`MO-${killed.requestId}`].displayStatus).toBe("cancelled");
    expect(by[`MO-${killed.requestId}`].workOrdersCount).toBe(2);
  });

  test("one cancelled work order among several does not cancel the order", async () => {
    const order = await mo();
    await wo(order, { status: "cancelled" });
    await wo(order, { status: "in_progress" });

    const { manufacturingOrders: [row] } = await listAt({});
    expect(row.displayStatus).toBe("in_progress");
  });
});

/* ═══ 3 · SEARCH ══════════════════════════════════════════════════════════ */

describe("search", () => {
  test("customer name and email are both searchable", async () => {
    const acme = await mo({ customerInfo: { name: "Acme Uniforms", email: "buy@acme.example" } });
    await mo({ customerInfo: { name: "Borealis", email: "po@borealis.example" } });

    expect(numbers((await call("?search=Acme")).body)).toEqual([`MO-${acme.requestId}`]);
    expect(numbers((await call("?search=buy@acme")).body)).toEqual([`MO-${acme.requestId}`]);
  });

  test("the displayed MO- number finds the order", async () => {
    // The stored field is the bare requestId; the screen shows MO-<requestId>.
    // Copying what is on screen used to match nothing.
    const order = await mo();
    const { body } = await call(`?search=MO-${order.requestId}`);
    expect(numbers(body)).toEqual([`MO-${order.requestId}`]);
  });

  test("the bare requestId still finds the order", async () => {
    const order = await mo();
    expect(numbers((await call(`?search=${order.requestId}`)).body)).toEqual([`MO-${order.requestId}`]);
  });

  test("the term is trimmed", async () => {
    const order = await mo({ customerInfo: { name: "Northbridge" } });
    expect(numbers((await call("?search=%20%20Northbridge%20%20")).body))
      .toEqual([`MO-${order.requestId}`]);
  });

  test("regex punctuation is literal text, not a pattern", async () => {
    // Each of these answered 500 before: an unterminated group, an unterminated
    // character class, a dangling quantifier.
    await mo();
    for (const q of ["%28", "%5Ba-z", "*", "%2B", "%3F", "%5C"]) {
      const { status, body } = await call(`?search=${q}`);
      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.manufacturingOrders).toEqual([]);
    }
  });

  test("a wildcard no longer matches the whole register", async () => {
    // `.*` was honoured as a pattern and returned everything.
    await mo(); await mo(); await mo();
    const { body } = await call("?search=.*");
    expect(body.manufacturingOrders).toEqual([]);
    expect(body.pagination.total).toBe(0);
  });

  test("punctuation in a real name is matched literally", async () => {
    const order = await mo({ customerInfo: { name: "Acme (Delhi) Pvt. Ltd." } });
    await mo({ customerInfo: { name: "Acme Delhi" } });

    const { body } = await call("?search=Acme%20(Delhi)");
    expect(numbers(body)).toEqual([`MO-${order.requestId}`]);
  });
});

/* ═══ 4 · FILTERS ═════════════════════════════════════════════════════════ */

describe("filters", () => {
  test("status filtering uses displayStatus, not the stored status", async () => {
    const pending = await mo();
    const started = await mo();
    await wo(started, { status: "in_progress" });

    expect(numbers((await call("?status=pending")).body)).toEqual([`MO-${pending.requestId}`]);
    expect(numbers((await call("?status=in_progress")).body)).toEqual([`MO-${started.requestId}`]);
  });

  test("priority filtering is server-backed", async () => {
    const urgent = await mo({ priority: "urgent" });
    await mo({ priority: "low" });
    await mo({ priority: "medium" });

    const { body } = await call("?priority=urgent");
    expect(numbers(body)).toEqual([`MO-${urgent.requestId}`]);
    expect(body.pagination.total).toBe(1);
  });

  test("deadline-risk filtering is server-backed", async () => {
    const late = await mo({ customerInfo: { deliveryDeadline: inDays(-5) } });
    const soon = await mo({ customerInfo: { deliveryDeadline: inDays(2) } });
    const later = await mo({ customerInfo: { deliveryDeadline: inDays(90) } });
    const undated = await mo();

    const risk = async (r) => (await listAt({ deadlineRisk: r })).manufacturingOrders.map((x) => x.moNumber);

    expect(await risk("overdue")).toEqual([`MO-${late.requestId}`]);
    expect(await risk("due_soon")).toEqual([`MO-${soon.requestId}`]);
    expect(await risk("on_track")).toEqual([`MO-${later.requestId}`]);
    expect(await risk("none")).toEqual([`MO-${undated.requestId}`]);
  });

  test("a completed or cancelled order is closed, not overdue", async () => {
    const done = await mo({ customerInfo: { deliveryDeadline: inDays(-30) } });
    await wo(done, { quantity: 10, status: "completed", productionCompletion: { overallCompletedQuantity: 10 } });

    const overdue = await listAt({ deadlineRisk: "overdue" });
    const closed = await listAt({ deadlineRisk: "closed" });

    expect(overdue.manufacturingOrders).toEqual([]);
    expect(closed.manufacturingOrders.map((r) => r.moNumber)).toEqual([`MO-${done.requestId}`]);
  });

  test("the estimate is used when no delivery deadline is recorded", async () => {
    const order = await mo({ estimatedCompletion: inDays(-2) });
    const { manufacturingOrders: [row] } = await listAt({ deadlineRisk: "overdue" });
    expect(row.moNumber).toBe(`MO-${order.requestId}`);
    expect(row.deliveryDeadline).toBeNull();
  });

  test("filters compose, and the total counts the composed set", async () => {
    const wanted = await mo({ priority: "urgent", customerInfo: { name: "Acme", deliveryDeadline: inDays(-1) } });
    await wo(wanted, { status: "in_progress" });

    await mo({ priority: "low", customerInfo: { name: "Acme", deliveryDeadline: inDays(-1) } });
    const wrongRisk = await mo({ priority: "urgent", customerInfo: { name: "Acme", deliveryDeadline: inDays(60) } });
    await wo(wrongRisk, { status: "in_progress" });
    await mo({ priority: "urgent", customerInfo: { name: "Borealis", deliveryDeadline: inDays(-1) } });

    const page = await listAt({ priority: "urgent", deadlineRisk: "overdue", status: "in_progress", search: "Acme" });
    expect(page.manufacturingOrders.map((r) => r.moNumber)).toEqual([`MO-${wanted.requestId}`]);
    expect(page.pagination.total).toBe(1);
  });

  test("absent filters change nothing", async () => {
    await mo({ priority: "urgent" }); await mo({ priority: "low" });
    const plain = await call();
    const empties = await call("?priority=&deadlineRisk=&status=&search=");
    expect(empties.body.pagination.total).toBe(plain.body.pagination.total);
    expect(numbers(empties.body)).toEqual(numbers(plain.body));
  });

  test("an unknown filter value narrows to nothing and never broadens", async () => {
    await mo(); await mo(); await mo();
    for (const q of ["?status=bogus", "?priority=bogus", "?deadlineRisk=bogus"]) {
      const { status, body } = await call(q);
      expect(status).toBe(200);
      expect(body.manufacturingOrders).toEqual([]);
      expect(body.pagination.total).toBe(0);
    }
  });
});

/* ═══ 5 · PAGINATION ══════════════════════════════════════════════════════ */

describe("pagination", () => {
  const seed = async (n) => { for (let i = 0; i < n; i++) await mo(); };

  test("totals are computed after filters, not before", async () => {
    await seed(3);
    const urgent = await mo({ priority: "urgent" });

    const { body } = await call("?priority=urgent&limit=2");
    expect(body.pagination.total).toBe(1);
    expect(body.pagination.pages).toBe(1);
    expect(numbers(body)).toEqual([`MO-${urgent.requestId}`]);
  });

  test("paging walks the whole set exactly once", async () => {
    await seed(7);
    const p1 = await call("?page=1&limit=3");
    const p2 = await call("?page=2&limit=3");
    const p3 = await call("?page=3&limit=3");

    expect(p1.body.pagination).toMatchObject({ total: 7, pages: 3 });
    const all = [...numbers(p1.body), ...numbers(p2.body), ...numbers(p3.body)];
    expect(all).toHaveLength(7);
    expect(new Set(all).size).toBe(7);
  });

  test("ordering is stable when rows share a timestamp", async () => {
    // The tie-breaker's whole purpose: without it two orders saved in the same
    // millisecond could appear on both pages, or on neither.
    await seed(6);
    const at = new Date("2026-09-01T00:00:00Z");
    await CustomerRequest.updateMany({}, { $set: { updatedAt: at } }, { timestamps: false });

    const once = [...numbers((await call("?page=1&limit=3")).body), ...numbers((await call("?page=2&limit=3")).body)];
    const again = [...numbers((await call("?page=1&limit=3")).body), ...numbers((await call("?page=2&limit=3")).body)];

    expect(new Set(once).size).toBe(6);
    expect(again).toEqual(once);
  });

  test("malformed pagination cannot produce a 500", async () => {
    await seed(2);
    for (const q of [
      "?page=abc", "?limit=abc", "?page=0", "?page=-3", "?limit=0", "?limit=-5",
      "?page=&limit=", "?page=NaN&limit=NaN", "?page[]=1", "?limit=Infinity",
    ]) {
      const { status, body } = await call(q);
      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.pagination.limit).toBeGreaterThan(0);
      expect(body.pagination.page).toBeGreaterThanOrEqual(1);
    }
  });

  test("a page size beyond the maximum is clamped, and says so", async () => {
    await seed(2);
    const { body } = await call("?limit=1000000000");
    expect(body.pagination.limit).toBe(100);
    expect(body.manufacturingOrders.length).toBeLessThanOrEqual(100);
  });

  test("an extreme page is bounded, not fatal", async () => {
    // `?page=1e308` made skip Infinity and reached the database as an invalid
    // $skip. Clamping the page SIZE alone never fixed that, because skip is
    // (page - 1) x limit.
    await seed(2);
    for (const q of ["?page=1e308", "?page=1.7976931348623157e308", "?page=9007199254740993", `?page=${MAX_PAGE + 1}`]) {
      const { status, body } = await call(q);
      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.pagination.page).toBe(MAX_PAGE);
      expect(Number.isSafeInteger(body.pagination.page)).toBe(true);
      // Far past the end of a two-row register, so nothing comes back — but as
      // an empty page, not a 500.
      expect(body.manufacturingOrders).toEqual([]);
      expect(body.pagination.total).toBe(2);
    }
  });

  test("the largest permitted page and page size together still answer", async () => {
    await seed(2);
    const { status, body } = await call(`?page=${MAX_PAGE}&limit=${MAX_LIMIT}`);
    expect(status).toBe(200);
    expect(body.pagination).toMatchObject({ page: MAX_PAGE, limit: MAX_LIMIT, total: 2 });
    expect(body.manufacturingOrders).toEqual([]);
  });

  test("a page past the end is empty, not an error", async () => {
    await seed(2);
    const { status, body } = await call("?page=99&limit=10");
    expect(status).toBe(200);
    expect(body.manufacturingOrders).toEqual([]);
    expect(body.pagination.total).toBe(2);
  });
});

/* ═══ 6 · THE BOUNDARY STAYS WHERE IT WAS ═════════════════════════════════ */

describe("cross-application compatibility", () => {
  test("authentication is unchanged", async () => {
    const anon = await call("?page=1&limit=5", { auth: false });
    expect(anon.status).toBe(401);
    expect(anon.body).not.toHaveProperty("manufacturingOrders");
  });

  test("no department role is required to read the register", async () => {
    // Cutting, QC, Packaging, the Production Supervisor and the CEO all read
    // manufacturing orders. This read must never become Project-Manager-only.
    await mo();
    const cutting = jwt.sign(
      { id: String(new mongoose.Types.ObjectId()), email: "cut@t.example", role: "cutting_master" },
      process.env.JWT_SECRET, { expiresIn: "10m" },
    );
    const res = await fetch(base, { headers: { Authorization: `Bearer ${cutting}` } })
      .then(async (r) => ({ status: r.status, body: JSON.parse(await r.text()) }));

    expect(res.status).toBe(200);
    expect(res.body.manufacturingOrders).toHaveLength(1);
  });

  test("the two shipped callers get exactly what they got before", async () => {
    // app/project-manager/dashboard/page.js:178 and
    // app/project-manager/dashboard/production/manufacturing-orders/page.js:98.
    await mo();
    const dash = await call("?page=1&limit=5");
    const register = await call("?page=1&limit=12&search=&status=");

    for (const { body } of [dash, register]) {
      expect(body.success).toBe(true);
      expect(Array.isArray(body.manufacturingOrders)).toBe(true);
      for (const key of ROW_FIELDS) expect(body.manufacturingOrders[0]).toHaveProperty(key);
    }
    expect(dash.body.pagination.limit).toBe(5);
    expect(register.body.pagination.limit).toBe(12);
  });
});
