// test/project-manager/production-trend.route.test.js
//
// The production-trend endpoint's contract, against a real Express router and an
// in-memory Mongo. Proportional: it checks the wire shape, the weeks clamp, the
// timestamp-only sourcing (the whole point of the endpoint) and the coverage
// counts — not every bucketing permutation, which productionTrend.test.js owns.

"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const WorkOrder = require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/cms/manufacturing/manufacturing-orders",
    require("../../routes/CMS_Routes/Manufacturing/Manufacturing-Order/manufacturingOrderRoutes"),
  );
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/manufacturing/manufacturing-orders`;
});

afterAll(async () => { await new Promise((r) => server.close(r)); });

const call = (path, { token } = {}) =>
  fetch(`${base}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
    .then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

function session() {
  const n = ++seq;
  return jwt.sign(
    { id: String(new mongoose.Types.ObjectId()), role: "project_manager", employeeId: `PM${n}`, name: `PM ${n}`, email: `pm${n}@test.example` },
    process.env.JWT_SECRET || "grav_clothing_secret_key",
    { expiresIn: "10m" },
  );
}

const wo = (over = {}) => {
  const n = ++seq;
  return WorkOrder.create({ workOrderNumber: `WO-${String(n).padStart(4, "0")}`, quantity: 10, ...over });
};

const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

describe("production-trend contract", () => {
  test("defaults to 8 weeks and returns the documented shape", async () => {
    const { status, body } = await call("/stats/production-trend", { token: session() });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.bucket).toBe("week");
    expect(body.weeks).toBe(8);
    expect(typeof body.asOf).toBe("string");
    expect(Array.isArray(body.points)).toBe(true);
    expect(body.points).toHaveLength(8);
    expect(Object.keys(body.points[0]).sort()).toEqual(
      ["completedWorkOrders", "periodEnd", "periodStart", "startedWorkOrders"],
    );
    expect(body.coverage).toEqual(
      expect.objectContaining({ startedWithoutTimestamp: expect.any(Number), completedWithoutTimestamp: expect.any(Number) }),
    );
  });

  test.each([[4], [8], [12]])("weeks=%i returns that many buckets", async (weeks) => {
    const { body } = await call(`/stats/production-trend?weeks=${weeks}`, { token: session() });
    expect(body.weeks).toBe(weeks);
    expect(body.points).toHaveLength(weeks);
  });

  test("an invalid weeks value falls back to 8, not a 400", async () => {
    for (const bad of ["7", "0", "-3", "abc", "999"]) {
      const { status, body } = await call(`/stats/production-trend?weeks=${bad}`, { token: session() });
      expect(status).toBe(200);
      expect(body.weeks).toBe(8);
    }
  });

  test("started counts actualStartDate only; completed counts actualEndDate only", async () => {
    // A work order STARTED three days ago but not yet finished.
    await wo({ status: "in_progress", timeline: { actualStartDate: daysAgo(3), actualEndDate: null } });
    // A work order COMPLETED three days ago, but STARTED long before the window
    // — so it belongs to the completed series only, proving the two series read
    // different columns rather than the same one.
    await wo({ status: "completed", timeline: { actualStartDate: daysAgo(40), actualEndDate: daysAgo(3) } });

    const { body } = await call("/stats/production-trend?weeks=4", { token: session() });
    const started = body.points.reduce((s, p) => s + p.startedWorkOrders, 0);
    const completed = body.points.reduce((s, p) => s + p.completedWorkOrders, 0);
    // Exactly one of each within the window, sourced from the right column.
    expect(started).toBe(1);
    expect(completed).toBe(1);
  });

  test("createdAt / updatedAt are NEVER used as a substitute for a missing stamp", async () => {
    // Completed work order with NO actualEndDate — it has a fresh updatedAt/
    // createdAt, but must not appear in any completed bucket, and must be
    // disclosed as coverage instead.
    await wo({ status: "completed", timeline: { actualStartDate: null, actualEndDate: null } });

    const { body } = await call("/stats/production-trend?weeks=8", { token: session() });
    const completed = body.points.reduce((s, p) => s + p.completedWorkOrders, 0);
    // The stampless completed order contributes NOTHING to the drawn series
    // (its updatedAt/createdAt are never a substitute)…
    expect(completed).toBe(0);
    // …it is disclosed as coverage instead. It is both "completed without a
    // completion stamp" and an execution-status record without a start stamp.
    expect(body.coverage.completedWithoutTimestamp).toBe(1);
    expect(body.coverage.startedWithoutTimestamp).toBe(1);
  });

  test("the endpoint requires a session", async () => {
    const { status } = await call("/stats/production-trend");
    // Whatever the router's gate is, an unauthenticated call must not succeed.
    expect(status).not.toBe(200);
  });

  test("the existing /stats/overview endpoint is untouched and still answers", async () => {
    const { status, body } = await call("/stats/overview", { token: session() });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.stats).toBeDefined();
    expect(body.stats.completedWO).toBeDefined();
  });
});
