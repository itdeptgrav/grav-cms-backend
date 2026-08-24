const test = require("node:test");
const assert = require("node:assert/strict");
const { nextRequestId } = require("./requestId");

// Stand-in for the model: only `.find(...).lean()` is used.
const modelWith = (ids) => ({
  find: () => ({ lean: async () => ids.map((requestId) => ({ requestId })) }),
});

test("an empty year starts at 0001", async () => {
  assert.equal(await nextRequestId(modelWith([]), 2026), "REQ-2026-0001");
});

test("it goes one past the HIGHEST id, not the count", async () => {
  // The bug in one line: three ids, highest 0009 -> must be 0010, never 0004.
  assert.equal(await nextRequestId(modelWith(["REQ-2026-0001", "REQ-2026-0009", "REQ-2026-0003"]), 2026), "REQ-2026-0010");
});

test("deleting an order cannot rewind the sequence", async () => {
  // countDocuments()+1 would hand back 0003 here and collide with the survivor.
  assert.equal(await nextRequestId(modelWith(["REQ-2026-0001", "REQ-2026-0003"]), 2026), "REQ-2026-0004");
});

test("existing duplicates do not derail it", async () => {
  assert.equal(await nextRequestId(modelWith(["REQ-2026-0003", "REQ-2026-0003", "REQ-2026-0007"]), 2026), "REQ-2026-0008");
});

test("another year's ids are ignored", async () => {
  assert.equal(await nextRequestId(modelWith(["REQ-2025-0099"]), 2026), "REQ-2026-0001");
});

test("malformed ids are skipped rather than throwing", async () => {
  assert.equal(await nextRequestId(modelWith(["REQ-2026-abc", "", null, "REQ-2026-0002"]), 2026), "REQ-2026-0003");
});

test("it keeps counting past four digits instead of wrapping", async () => {
  assert.equal(await nextRequestId(modelWith(["REQ-2026-9999"]), 2026), "REQ-2026-10000");
});
