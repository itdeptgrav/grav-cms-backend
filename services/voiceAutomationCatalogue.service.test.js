"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { catalogue, snapshot } = require("./voiceAutomationCatalogue.service");

test("catalogue exposes the morning brief as a bounded pilot without promoting later adapters", () => {
  const workflows = catalogue({ voiceHealth: { enabled: true, ready: true, missing: [] } });
  assert.equal(workflows.find((row) => row.key === "mrf_approval").status, "live");
  assert.equal(workflows.find((row) => row.key === "morning_brief").status, "pilot");
  assert.equal(workflows.find((row) => row.key === "morning_brief").testable, true);
  assert.equal(workflows.find((row) => row.key === "manager_leave").status, "domain_gate");
  assert.deepEqual(new Set(workflows.map((row) => row.mode)), new Set(["decision", "briefing", "reminder"]));
});

test("MRF health failure is surfaced as a typed gate", () => {
  const workflows = catalogue({
    voiceHealth: { enabled: true, ready: false, missing: ["voice workflow worker name"] },
  });
  const mrf = workflows.find((row) => row.key === "mrf_approval");
  assert.equal(mrf.status, "needs_attention");
  assert.match(mrf.nextGate, /worker name/);
  assert.equal(mrf.testable, false);
});

test("platform snapshot retains recent evidence and safety defaults", () => {
  const out = snapshot({
    voiceHealth: { enabled: false, ready: false, missing: [] },
    recentAttempts: [{ id: "attempt-1", status: "NO_ANSWER" }],
  });
  assert.equal(out.schemaVersion, 1);
  assert.equal(out.platform.liveWorkflows, 0);
  assert.equal(out.policies.separateDecisionConfirmation, true);
  assert.equal(out.policies.rawAudioRecordedByDefault, false);
  assert.equal(out.recentAttempts[0].status, "NO_ANSWER");
});

test("platform language availability follows the installed voice contract", () => {
  const out = snapshot({
    voiceHealth: { enabled: true, ready: true, missing: [], languages: ["en", "hi", "or"] },
  });
  assert.deepEqual(out.platform.languages.map((row) => [row.code, row.available]), [
    ["en", true], ["hi", true], ["or", true],
  ]);
});

