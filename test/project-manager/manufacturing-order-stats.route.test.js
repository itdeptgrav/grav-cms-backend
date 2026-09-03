// test/project-manager/manufacturing-order-stats.route.test.js
//
// Project Manager professionalisation — Chunk 1. Contract coverage for the two
// endpoints the PM landing page now reads.
//
// The landing page used to render invented numbers. Replacing them with live
// ones only helps if the shape those numbers arrive in is pinned, so this file
// is a characterization harness rather than a behaviour change: it asserts what
// `/stats/overview` and the manufacturing-order list already do, so a later
// chunk that reorganises this router has to notice when it stops doing it.
//
// The specific worry the plan raised is route ordering: `GET /:id` is declared
// ~800 lines ABOVE `GET /stats/overview` in the same router. Express 5 path
// matching is per-segment, so a one-segment `:id` pattern cannot swallow a
// two-segment path — but that is an assumption about the installed router
// version, and an assumption is exactly what a test is for. `reachability`
// below proves it against the real Express in package.json instead.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
const WorkOrder = require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");

/* The eight established keys — the contract consumers may rely on. Named once
   so a removal and a rename both fail loudly, in one place. This is a floor,
   not a ceiling: the server may add fields without breaking anyone. */
const STATS_FIELDS = [
  "totalMO",
  "totalWO",
  "ongoingWO",
  "completedWO",
  "pendingWO",
  "forwardedWO",
  "newMOThisMonth",
  "completedWOThisMonth",
];

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  // Mounted exactly as server.js mounts it (server.js:1528-1532), so the paths
  // exercised here are the paths the browser calls.
  app.use(
    "/api/cms/manufacturing/manufacturing-orders",
    require("../../routes/CMS_Routes/Manufacturing/Manufacturing-Order/manufacturingOrderRoutes"),
  );
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/manufacturing/manufacturing-orders`;
});

afterAll(async () => { await new Promise((r) => server.close(r)); });

const call = (path, { token } = {}) =>
  fetch(`${base}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  }).then(async (r) => ({
    status: r.status,
    body: JSON.parse((await r.text()) || "null"),
  }));

/** A signed CMS session, the same shape routes/login.js mints. */
function session({ role = "project_manager" } = {}) {
  const n = ++seq;
  return jwt.sign(
    {
      id: String(new mongoose.Types.ObjectId()),
      role,
      employeeId: `PM${n}`,
      name: `PM ${n}`,
      email: `pm${n}@test.example`,
    },
    process.env.JWT_SECRET || "grav_clothing_secret_key",
    { expiresIn: "10m" },
  );
}

/**
 * A manufacturing order is not its own record: it is a CustomerRequest that
 * Sales approved. `status` defaults to that approved value because every count
 * and every list row on this router is scoped to it.
 */
const mo = (over = {}) => {
  const n = ++seq;
  return CustomerRequest.create({
    requestId: `REQ-${String(n).padStart(4, "0")}`,
    status: "quotation_sales_approved",
    priority: "medium",
    customerInfo: { name: `Customer ${n}`, email: `c${n}@test.example` },
    items: [{ totalQuantity: 10 }],
    ...over,
  });
};

const wo = (over = {}) => {
  const n = ++seq;
  return WorkOrder.create({
    workOrderNumber: `WO-${String(n).padStart(4, "0")}`,
    quantity: 10,
    ...over,
  });
};

/* ═══ 1 · REACHABILITY ═══════════════════════════════════════════════════ */

describe("reachability", () => {
  /**
   * The whole point of the ordering question. If `/:id` captured this path the
   * request would land in the detail handler, which looks up an id of
   * "stats" — so a capture shows up as a 400/404/500 with no `stats` key, not
   * as a passing test with odd numbers.
   */
  test("GET /stats/overview reaches the stats handler, not GET /:id", async () => {
    const res = await call("/stats/overview", { token: session() });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("stats");
    // The detail handler answers with `manufacturingOrder`; the stats handler
    // never does. Asserting the absence pins which handler replied.
    expect(res.body).not.toHaveProperty("manufacturingOrder");
  });

  test("the sibling one-segment path still reaches GET /:id", async () => {
    // Same router, same session: proves the detail route was not disturbed and
    // that `stats` above is a segment-count win, not a dead `/:id`.
    const res = await call(`/${new mongoose.Types.ObjectId()}`, { token: session() });

    expect(res.status).toBe(404);
    expect(res.body).not.toHaveProperty("stats");
  });
});

/* ═══ 2 · AUTHENTICATION ═════════════════════════════════════════════════ */

/* Both endpoints the dashboard reads, with the key each returns on success —
   the key that must be absent when the request is refused. */
const GUARDED = [
  { name: "the stats overview", path: "/stats/overview", payloadKey: "stats" },
  {
    name: "the manufacturing-order list",
    path: "?page=1&limit=5",
    payloadKey: "manufacturingOrders",
  },
];

/* Every way a session can be missing or unusable. Spot-checking one mode on one
   endpoint is what let "both endpoints refuse anonymous, junk and expired
   sessions" be written down before it was true: the list had only the anonymous
   case. Running the matrix removes the gap rather than narrowing the claim. */
const REFUSALS = [
  { name: "an anonymous request", token: () => undefined },
  { name: "a junk token", token: () => "not-a-jwt" },
  {
    name: "an expired session",
    token: () =>
      jwt.sign(
        { id: String(new mongoose.Types.ObjectId()), role: "project_manager" },
        process.env.JWT_SECRET || "grav_clothing_secret_key",
        { expiresIn: -10 },
      ),
  },
];

describe("authentication", () => {
  for (const endpoint of GUARDED) {
    for (const refusal of REFUSALS) {
      test(`${refusal.name} is refused by ${endpoint.name}`, async () => {
        const res = await call(endpoint.path, { token: refusal.token() });

        expect(res.status).toBe(401);
        expect(res.body.success).toBe(false);
        // The refusal must not leak the payload it was protecting.
        expect(res.body).not.toHaveProperty(endpoint.payloadKey);
      });
    }
  }
});

/* ═══ 3 · RESPONSE CONTRACT ══════════════════════════════════════════════ */

describe("stats response contract", () => {
  test("empty collections return real zeroes, not an error or an absence", async () => {
    // The honesty rule the dashboard depends on: a missing field would be
    // rendered as "—", but a served zero must be rendered as 0. They are
    // different answers and only the server can tell them apart.
    const res = await call("/stats/overview", { token: session() });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    for (const key of STATS_FIELDS) {
      expect(res.body.stats[key]).toBe(0);
    }
  });

  test("the envelope is { success, stats } and every established field is present and numeric", async () => {
    await mo();
    const res = await call("/stats/overview", { token: session() });

    // The envelope: both keys present, `success` true. Asserted by presence
    // rather than by an exact key list — adding a field to a response is a
    // backward-compatible change every consumer here already tolerates, and a
    // test that fails on it turns a safe addition into a broken build.
    // Removals and renames are what break consumers, and those still fail
    // below: each of the eight is looked up by name.
    expect(res.body).toHaveProperty("success", true);
    expect(res.body).toHaveProperty("stats");
    expect(res.body.stats).not.toBeNull();
    expect(typeof res.body.stats).toBe("object");

    for (const key of STATS_FIELDS) {
      expect(res.body.stats).toHaveProperty(key);
      // `Number.isFinite`, not `typeof === "number"`: NaN and Infinity are
      // both typeof "number" and both render as garbage on the dashboard, so
      // a count that degrades into one has to fail here too.
      expect(Number.isFinite(res.body.stats[key])).toBe(true);
    }
  });

  test("each count keeps its existing meaning", async () => {
    // Characterization, not redefinition. If a later chunk decides `pendingWO`
    // should stop including `ready_to_start`, this is the test that has to be
    // edited deliberately — which is the point.
    const order = await mo();
    await mo({ status: "pending" });                        // not sales-approved → not an MO

    await wo({ customerRequestId: order._id, status: "in_progress" });
    await wo({ customerRequestId: order._id, status: "completed" });
    await wo({ customerRequestId: order._id, status: "pending" });
    await wo({ customerRequestId: order._id, status: "planned" });
    await wo({ customerRequestId: order._id, status: "scheduled" });
    await wo({ customerRequestId: order._id, status: "ready_to_start" });
    await wo({ customerRequestId: order._id, status: "forwarded" });
    await wo({ customerRequestId: order._id, status: "cancelled" });

    const { body } = await call("/stats/overview", { token: session() });

    expect(body.stats.totalMO).toBe(1);                  // sales-approved only
    expect(body.stats.totalWO).toBe(8);                  // every WO, cancelled included
    expect(body.stats.ongoingWO).toBe(1);                // status "in_progress"
    expect(body.stats.completedWO).toBe(1);
    expect(body.stats.pendingWO).toBe(4);                // pending+planned+scheduled+ready_to_start
    expect(body.stats.forwardedWO).toBe(1);
  });

  test("the two month counts are scoped to the current calendar month", async () => {
    /* Written through the raw driver: mongoose marks `createdAt` immutable
       under `timestamps`, so a model-level $set on it is silently dropped and
       the "old" record would still be this month's. */
    const lastCentury = new Date("2020-01-15T00:00:00Z");

    const old = await mo();
    await CustomerRequest.collection.updateOne(
      { _id: old._id },
      { $set: { createdAt: lastCentury } },
    );
    await mo();                                          // created now

    const stale = await wo({ status: "completed" });
    await WorkOrder.collection.updateOne(
      { _id: stale._id },
      { $set: { updatedAt: lastCentury } },
    );
    await wo({ status: "completed" });                   // updated now

    const { body } = await call("/stats/overview", { token: session() });

    expect(body.stats.totalMO).toBe(2);
    expect(body.stats.newMOThisMonth).toBe(1);
    expect(body.stats.completedWO).toBe(2);
    expect(body.stats.completedWOThisMonth).toBe(1);
  });
});

/* ═══ 4 · THE LIST THE DASHBOARD PAGES ═══════════════════════════════════ */

describe("recent manufacturing orders", () => {
  test("page=1&limit=5 returns at most five rows with the fields the dashboard renders", async () => {
    for (let i = 0; i < 7; i++) {
      await mo({ priority: "high", customerInfo: { name: `Buyer ${i}`, deliveryDeadline: new Date() } });
    }

    const { status, body } = await call("?page=1&limit=5", { token: session() });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.manufacturingOrders).toHaveLength(5);
    expect(body.pagination).toMatchObject({ page: 1, limit: 5, total: 7, pages: 2 });

    // Exactly the fields the landing page displays. Nothing is invented on the
    // client, so each one has to survive here.
    const row = body.manufacturingOrders[0];
    for (const key of [
      "_id", "moNumber", "customerInfo", "displayStatus",
      "priority", "completionPercentage", "deliveryDeadline",
    ]) {
      expect(row).toHaveProperty(key);
    }
    expect(row.moNumber).toMatch(/^MO-/);
  });

  test("no manufacturing orders is an empty list and a zero total, not an error", async () => {
    const { status, body } = await call("?page=1&limit=5", { token: session() });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.manufacturingOrders).toEqual([]);
    expect(body.pagination.total).toBe(0);
  });

  test("displayStatus stays inside the register's four-value vocabulary", async () => {
    // The dashboard reuses the manufacturing-order register's status map. A
    // fifth value would render as an unlabelled chip there and here.
    const plain = await mo();
    const started = await mo();
    await wo({ customerRequestId: started._id, status: "in_progress" });
    const done = await mo();
    await wo({
      customerRequestId: done._id,
      status: "completed",
      quantity: 10,
      productionCompletion: { overallCompletedQuantity: 10 },
    });

    const { body } = await call("?page=1&limit=5", { token: session() });
    const byId = Object.fromEntries(
      body.manufacturingOrders.map((r) => [String(r._id), r.displayStatus]),
    );

    expect(byId[String(plain._id)]).toBe("pending");
    expect(byId[String(started._id)]).toBe("in_progress");
    expect(byId[String(done._id)]).toBe("completed");
    for (const value of Object.values(byId)) {
      expect(["pending", "in_progress", "completed", "cancelled"]).toContain(value);
    }
  });
});
