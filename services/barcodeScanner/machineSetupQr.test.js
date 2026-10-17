// node --test services/barcodeScanner/machineSetupQr.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const q = require("./machineSetupQr");

const M = { _id: "6ad3877d205ee14885596828", name: "Kansai-02", type: "DNLS" };

test("the payload is the firmware's MID/MNAME format, from the register's own id and name", () => {
  assert.equal(q.machineSetupPayload(M), "MID:6ad3877d205ee14885596828,MNAME:Kansai-02");
  assert.equal(q.machineSetupPayload({ ...M, name: "  SNLS36 " }), "MID:6ad3877d205ee14885596828,MNAME:SNLS36");
  assert.equal(q.machineSetupPayload({ toString() {}, _id: { toString: () => M._id }, name: "A" }), `MID:${M._id},MNAME:A`, "an ObjectId works");
});

test("no payload without a real id and a name", () => {
  assert.equal(q.machineSetupPayload({ ...M, _id: "abc" }), null);
  assert.equal(q.machineSetupPayload({ ...M, name: "  " }), null);
  assert.equal(q.machineSetupPayload(null), null);
});

test("a name holding the firmware's separators is warned about, not refused", () => {
  assert.equal(q.payloadWarning(M), null);
  assert.match(q.payloadWarning({ ...M, name: "SNLS, line 2" }), /comma or colon/);
  assert.ok(q.machineSetupPayload({ ...M, name: "SNLS, line 2" }));
});

test("the QR is drawn as an SVG, width clamped like /scanner/qr", async () => {
  const svg = await q.drawSetupQr(q.machineSetupPayload(M), 9999);
  assert.match(svg, /^<svg[^>]*width="600"/);
  assert.equal(q.clampWidth(10), 100);
  assert.equal(q.clampWidth(undefined), 240);
});
