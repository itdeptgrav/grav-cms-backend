// The /flow HTTP boundary: authentication, then a proved company, then the
// service — with injected stand-ins so no database is touched.
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");

const { createFlowTrackingRouter } = require("../../../routes/CMS_Routes/Production/Scanner/flowTrackingRoutes");
const { FlowTrackingError } = require("./flowTracking.service");

const CO_A = "64000000000000000000000a";

async function serve(deps, fn) {
  const app = express();
  app.use("/api/cms/production/supervisor", createFlowTrackingRouter(deps));
  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/cms/production/supervisor`;
    return await fn(base);
  } finally {
    server.close();
  }
}

const allow = (_req, _res, next) => next();
const company = (companyId) => (req, _res, next) => { req.merchandising = { companyId }; next(); };

test("unauthenticated requests never reach the service", async () => {
  let called = false;
  const deps = {
    authenticate: (_req, res) => res.status(401).json({ success: false, message: "Authentication required" }),
    resolveCompany: allow,
    service: () => { called = true; return {}; },
  };
  await serve(deps, async (base) => {
    assert.equal((await fetch(`${base}/flow`)).status, 401);
    assert.equal((await fetch(`${base}/flow/work-orders/66f0a1b2c3d4e5f6a7b81842`)).status, 401);
  });
  assert.equal(called, false);
});

test("a session with no provable company is refused with the company middleware's shape", async () => {
  let called = false;
  const deps = {
    authenticate: allow,
    resolveCompany: (_req, res) => res.status(403).json({ success: false, code: "COMPANY_MEMBERSHIP_REQUIRED", message: "No company." }),
    service: () => { called = true; return {}; },
  };
  await serve(deps, async (base) => {
    const res = await fetch(`${base}/flow`);
    assert.equal(res.status, 403);
    assert.equal((await res.json()).code, "COMPANY_MEMBERSHIP_REQUIRED");
  });
  assert.equal(called, false);
});

test("the company comes from the middleware, never from the query string", async () => {
  const seen = [];
  const deps = {
    authenticate: allow,
    resolveCompany: company(CO_A),
    service: () => ({
      activeFlow: async (args) => { seen.push([args.companyId, args.capacityLineId]); return { workOrders: [] }; },
      workOrderFlow: async () => { throw new FlowTrackingError(404, "No work order of your company has that id.", "NOT_FOUND"); },
    }),
  };
  await serve(deps, async (base) => {
    const ok = await fetch(`${base}/flow?capacityLineId=680000000000000000000a01&companyId=64000000000000000000000b&actingCompanyId=64000000000000000000000b`);
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { success: true, workOrders: [] });
    const foreign = await fetch(`${base}/flow/work-orders/66f0a1b2c3d4e5f6a7b89999`);
    assert.equal(foreign.status, 404);
    assert.deepEqual(await foreign.json(), { success: false, code: "NOT_FOUND", message: "No work order of your company has that id." });
  });
  assert.deepEqual(seen, [[CO_A, "680000000000000000000a01"]]);
});

test("the router answers only /flow paths, so other supervisor routers are untouched", async () => {
  let authCalls = 0;
  const deps = { authenticate: (_q, _s, next) => { authCalls++; next(); }, resolveCompany: company(CO_A), service: () => ({}) };
  await serve(deps, async (base) => {
    assert.equal((await fetch(`${base}/overview`)).status, 404);
  });
  assert.equal(authCalls, 0);
});

test("the HTTP boundary refuses a company-wide or physical-floor request with stable codes", async () => {
  const { createFlowTrackingService } = require("./flowTracking.service");
  const service = createFlowTrackingService({
    workOrderById: async () => null,
    activeWorkOrders: async () => [],
    capacityLine: async (_c, id) => (id === "680000000000000000000a01"
      ? { _id: id, companyId: CO_A, lineRef: "A1", revision: 1, status: "ACTIVE" } : null),
    lineProvenByBasis: async () => false,
    scanEvents: async () => [],
    collidingShortIds: async () => new Set(),
    currentAssignments: async () => [],
    ownedMachineIds: async () => [],
    companyCanvasLayout: async () => null,
  });
  const deps = { authenticate: allow, resolveCompany: company(CO_A), service: () => service };
  await serve(deps, async (base) => {
    const noLine = await fetch(`${base}/flow`);
    assert.equal(noLine.status, 400);
    assert.equal((await noLine.json()).code, "PLANNING_LINE_SCOPE_REQUIRED");
    const foreignLine = await fetch(`${base}/flow?capacityLineId=680000000000000000000b01`);
    assert.equal(foreignLine.status, 404);
    assert.equal((await foreignLine.json()).code, "CAPACITY_LINE_NOT_FOUND");
    const zone = await fetch(`${base}/flow?capacityLineId=680000000000000000000a01&zoneId=line-01`);
    assert.equal(zone.status, 409);
    assert.equal((await zone.json()).code, "ZONE_CONTEXT_UNAVAILABLE");
    const machine = await fetch(`${base}/flow?capacityLineId=680000000000000000000a01&machineId=650000000000000000000001`);
    assert.equal(machine.status, 404);
    assert.equal((await machine.json()).code, "MACHINE_NOT_FOUND");
  });
});
