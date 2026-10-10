// services/manufacturing/recordedAt.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const { boundedRecordedAt, MAX_AGE_MS } = require("./recordedAt");

const NOW = new Date("2026-10-09T10:00:00.000Z");

test("a scan made earlier on the device keeps its own time", () => {
  assert.equal(boundedRecordedAt("2026-10-09T06:30:00.000Z", NOW).toISOString(), "2026-10-09T06:30:00.000Z");
});

test("an outage that crossed midnight keeps the earlier day", () => {
  assert.equal(boundedRecordedAt("2026-10-08T17:00:00.000Z", NOW).toISOString(), "2026-10-08T17:00:00.000Z");
});

test("absent or unreadable means now", () => {
  for (const v of [undefined, null, "", "not a date"]) assert.equal(boundedRecordedAt(v, NOW), NOW);
});

test("a device clock in the future is not believed (beyond small skew)", () => {
  assert.equal(boundedRecordedAt("2026-10-09T10:01:00.000Z", NOW).toISOString(), "2026-10-09T10:01:00.000Z");
  assert.equal(boundedRecordedAt("2026-10-09T11:00:00.000Z", NOW), NOW);
});

test("nothing older than the limit is believed", () => {
  assert.equal(boundedRecordedAt(new Date(NOW.getTime() - MAX_AGE_MS - 1000).toISOString(), NOW), NOW);
});
