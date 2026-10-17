// services/production/orderSimulationRuns.test.js
//
// The Order simulation's history: what a saved run must carry, the packed
// report round-trips, and only whoever ran a run (or an admin) changes it.
const test = require("node:test");
const assert = require("node:assert/strict");
const { packReport, unpackReport, runFromBody, canChange, editsFromBody } = require("./orderSimulationRuns");

const report = { meta: { product: "Black Pant", quantity: 7000 }, A: { planned: { days: [{ day: 1, pieces: 200 }] } }, B: { optimised: { days: [] } } };

test("a report is kept gzip and comes back exactly as it was", () => {
  const big = { ...report, filler: "x".repeat(200000) };
  const { buffer, bytes } = packReport(big);
  assert.ok(buffer.length < bytes / 10, `packed ${buffer.length} of ${bytes} bytes`);
  assert.deepEqual(unpackReport(buffer), big);
  assert.equal(unpackReport(null), null);
});

test("a run needs a real report; the rest is bounded and taken from the body", () => {
  assert.match(runFromBody({}).error, /no simulation report/);
  assert.match(runFromBody({ report: { meta: {} } }).error, /no simulation report/);
  const { run } = runFromBody({
    report, name: "  Both lines  ", quantity: "7000", layoutVersion: 44, machines: 90,
    product: { id: "p1", name: "Black Pant" },
    lines: [{ id: "line-1", name: "Line 1", day: 1, operators: 18 }, { id: "line-2", name: "Line 2", day: 10, operators: 18 }],
    summary: { A: { plannedDays: 25 } }, inputs: { quantity: 7000 },
  });
  assert.equal(run.name, "Both lines");
  assert.equal(run.quantity, 7000);
  assert.equal(run.layoutVersion, 44);
  assert.deepEqual(run.lines.map((l) => [l.name, l.day]), [["Line 1", 1], ["Line 2", 10]]);
  assert.deepEqual(run.summary, { A: { plannedDays: 25 } });
  assert.equal(runFromBody({ report }).run.product.name, "Black Pant", "the product name falls back to the report's");
});

test("only whoever ran a run, or an administrator, may rename or delete it", () => {
  const run = { createdBy: { id: "u1", email: "Owner@grav.in" } };
  assert.equal(canChange(run, { id: "u1" }), true);
  assert.equal(canChange(run, { id: "u2", email: "owner@grav.in" }), true, "the same person by e-mail");
  assert.equal(canChange(run, { id: "u2", email: "someone@grav.in" }), false);
  assert.equal(canChange(run, { id: "u3", isAdmin: true }), true);
  assert.equal(canChange(run, null), false);
});

test("an edit changes the name and the note only", () => {
  assert.deepEqual(editsFromBody({ name: " New ", note: "kept", report: {}, createdBy: "x" }), { name: "New", note: "kept" });
  assert.deepEqual(editsFromBody({}), {});
});
