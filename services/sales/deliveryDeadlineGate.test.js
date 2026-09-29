const test = require("node:test");
const assert = require("node:assert/strict");
const { requireDeliveryDeadline, CODE } = require("./deliveryDeadlineGate");

test("a request with a deadline passes and is left alone", () => {
  const req = { customerInfo: { deliveryDeadline: new Date("2026-10-10") } };
  assert.equal(requireDeliveryDeadline(req, {}), null);
  assert.equal(req.customerInfo.deliveryDeadline.toISOString().slice(0, 10), "2026-10-10");
});

test("a request with none is refused with the code the UI acts on, and nothing is written", () => {
  const req = { customerInfo: { name: "X" } };
  const r = requireDeliveryDeadline(req, { notes: "hi" });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, CODE);
  assert.equal(req.customerInfo.deliveryDeadline, undefined);
});

test("a date handed in the body is recorded on the request first", () => {
  const marked = [];
  const req = { customerInfo: { name: "X" }, markModified: (p) => marked.push(p) };
  assert.equal(requireDeliveryDeadline(req, { deliveryDeadline: "2026-11-01" }), null);
  assert.equal(req.customerInfo.deliveryDeadline.toISOString().slice(0, 10), "2026-11-01");
  assert.deepEqual(marked, ["customerInfo"]);
});

test("the on-behalf door's customerInfoOverride carries it too; garbage is not a date", () => {
  const a = { customerInfo: {} };
  assert.equal(requireDeliveryDeadline(a, { customerInfoOverride: { deliveryDeadline: "2026-12-01" } }), null);
  const b = { customerInfo: {} };
  assert.equal(requireDeliveryDeadline(b, { deliveryDeadline: "not a date" }).body.code, CODE);
});
