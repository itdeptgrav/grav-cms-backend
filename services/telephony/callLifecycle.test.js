"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { canonicalState, isTerminal, canTransition } = require("./callLifecycle");

test("canonical call lifecycle accepts only the closed state set", () => {
  assert.equal(canonicalState(" in_progress "), "IN_PROGRESS");
  assert.throws(() => canonicalState("answered-ish"), { code: "UNSUPPORTED_CALL_STATE" });
});

test("terminal states are final while duplicate notifications are idempotent", () => {
  assert.equal(isTerminal("COMPLETED"), true);
  assert.equal(canTransition("QUEUED", "COMPLETED"), true);
  assert.equal(canTransition("IN_PROGRESS", "IN_PROGRESS"), true);
  assert.equal(canTransition("COMPLETED", "FAILED"), false);
});

test("live state cannot move backwards", () => {
  assert.equal(canTransition("QUEUED", "CUSTOMER_RINGING"), true);
  assert.equal(canTransition("CUSTOMER_RINGING", "AGENT_RINGING"), false);
});

