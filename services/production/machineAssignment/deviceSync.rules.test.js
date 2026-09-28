const test = require("node:test");
const assert = require("node:assert/strict");
const {
  observeDevice, computeDelta, payloadsFor, evaluateSync, initialSync, sameCodes, validDeviceCode,
} = require("./deviceSync.rules");

const M = "650000000000000000000001";
const OTHER = "650000000000000000000002";
const NOW = new Date("2026-09-28T10:00:00.000Z");
const ago = (s) => new Date(NOW.getTime() - s * 1000);
const STALE = 180000;
const BASE_REV = 10; // DEV-1's evidenceRevision captured after the commit

/** A heartbeat document as the ingest route leaves it. `rev` defaults to the next revision. */
const hb = (codes, secondsAgo, over = {}) => ({
  deviceId: "DEV-1", machineId: M, activeOps: codes, lastHeartbeatAt: ago(secondsAgo), evidenceRevision: BASE_REV + 1, ...over,
});
const opts = (heartbeats, extra = {}) => ({ machineId: M, revision: 3, heartbeats, knownCodes: ["SJ-01", "CT007", "AP001"], now: NOW, staleMs: STALE, ...extra });
const withBaseline = (sync, devices = [{ deviceId: "DEV-1", evidenceRevision: BASE_REV }]) => ({ ...sync, evidenceBaseline: { devices } });
const fresh = (desired = ["SJ-01"], productionAssigned = true) =>
  withBaseline(initialSync({ revision: 3, desiredCodes: desired, productionAssigned, transitionAt: ago(125) }));

/* ══ causal evidence ═══════════════════════════════════════════════════════ */

test("no baseline: nothing is observed, even a perfect match", () => {
  const unbounded = initialSync({ revision: 3, desiredCodes: ["SJ-01"], productionAssigned: true, transitionAt: ago(125) });
  assert.equal(unbounded.evidenceBaseline, null);
  for (const codes of [["SJ-01"], ["CT007"]]) {
    const s = evaluateSync(unbounded, opts([hb(codes, 5, { evidenceRevision: 99 })]));
    assert.deepEqual([s.status, s.reasons, s.instruction, s.appliedRevision], ["pending_device_state", ["evidence_baseline_not_established"], undefined, null]);
  }
});

test("the captured revision itself never qualifies — however new its timestamp", () => {
  for (const at of [30, 1, -60]) {
    const s = evaluateSync(fresh(), opts([hb(["SJ-01"], at, { evidenceRevision: BASE_REV })]));
    assert.deepEqual([s.status, s.reasons, s.instruction], ["pending_device_state", ["no_heartbeat_since_assignment_commit"], undefined]);
  }
  assert.equal(evaluateSync(fresh(), opts([hb(["SJ-01"], 1, { evidenceRevision: BASE_REV - 3 })])).status, "pending_device_state");
});

test("the next evidence revision qualifies", () => {
  const s = evaluateSync(fresh(), opts([hb(["SJ-01"], 5, { evidenceRevision: BASE_REV + 1 })]));
  assert.deepEqual([s.status, s.appliedRevision, s.observed.evidenceRevision], ["applied", 3, BASE_REV + 1]);
});

test("a historical heartbeat without a revision needs one more heartbeat", () => {
  const historical = hb(["SJ-01"], 5, { evidenceRevision: undefined });
  const baseline0 = withBaseline(fresh(["SJ-01"]), [{ deviceId: "DEV-1", evidenceRevision: 0 }]);
  assert.equal(evaluateSync(baseline0, opts([historical])).status, "pending_device_state");
  assert.equal(evaluateSync(baseline0, opts([{ ...historical, evidenceRevision: 1 }])).status, "applied");
});

test("a device absent from the baseline qualifies from its first counted heartbeat", () => {
  assert.equal(evaluateSync(fresh(), opts([hb(["SJ-01"], 5, { deviceId: "DEV-NEW", evidenceRevision: 1 })])).status, "applied");
});

test("freshness still applies: a qualifying but stale heartbeat is not current device state", () => {
  assert.deepEqual(evaluateSync(fresh(), opts([hb(["SJ-01"], 600)])).reasons, ["heartbeat_stale"]);
});

test("no barcode from missing, ambiguous or unparseable device state", () => {
  const cases = [
    [[], "no_heartbeat"],
    [[hb(["CT007"], 30), hb(["AP001"], 20, { deviceId: "DEV-2", evidenceRevision: 4 })], "multiple_devices_disagree"],
    [[hb(["CT 007"], 30)], "heartbeat_codes_unparseable"],
    [[hb(["CT007", "ct007"], 30)], "heartbeat_codes_unparseable"],
    [[hb(["CT007"], 30, { machineId: OTHER })], "no_heartbeat"],
  ];
  for (const [heartbeats, reason] of cases) {
    const s = evaluateSync(fresh(), opts(heartbeats));
    assert.equal(s.status, "pending_device_state", reason);
    assert.deepEqual(s.reasons, [reason]);
    assert.equal(s.instruction, undefined);
  }
});

/* ══ toggles ═══════════════════════════════════════════════════════════════ */

test("symmetric difference, removals first, in the existing ops:/opsgp: format", () => {
  const s = evaluateSync(fresh(["SJ-01"]), opts([hb(["CT007", "AP001"], 30)]));
  assert.equal(s.status, "ready_to_sync");
  assert.deepEqual(s.instruction.toggles, [
    { code: "CT007", action: "remove" }, { code: "AP001", action: "remove" }, { code: "SJ-01", action: "add" }]);
  assert.deepEqual(s.instruction.payloads, ["opsgp:CT007,AP001,SJ-01"]);
  assert.deepEqual([s.instruction.forRevision, s.instruction.deviceId, s.instruction.observedEvidenceRevision], [3, "DEV-1", BASE_REV + 1]);
  assert.deepEqual(evaluateSync(fresh(["SJ-01"]), opts([hb([], 30)])).instruction.payloads, ["ops:SJ-01"]);
  assert.deepEqual(evaluateSync(fresh(["SJ-01"]), opts([hb(["SJ-01", "CT007"], 30)])).instruction.toggles, [{ code: "CT007", action: "remove" }]);
});

test("an unmapped observed code is never switched off by a generated barcode", () => {
  const s = evaluateSync(fresh(["SJ-01"]), opts([hb(["KUT004"], 30)]));
  assert.deepEqual([s.status, s.reasons, s.instruction], ["drift", ["unmapped_observed_codes", "unmapped:KUT004"], undefined]);
  assert.equal(evaluateSync(fresh(["SJ-01"]), opts([hb(["KUT004"], 30)], { knownCodes: ["KUT004"] })).status, "ready_to_sync");
});

test("repeated evaluation is idempotent; only a newer evidence revision replaces an unacknowledged instruction", () => {
  const first = evaluateSync(fresh(), opts([hb(["CT007"], 30)]));
  assert.equal(evaluateSync(first, opts([hb(["CT007"], 30)])).instruction.instructionId, first.instruction.instructionId);
  // Same revision, later clock: NOT newer evidence.
  assert.equal(evaluateSync(first, opts([hb(["CT007"], 1)])).instruction.instructionId, first.instruction.instructionId);
  const newer = evaluateSync(first, opts([hb(["CT007", "AP001"], 10, { evidenceRevision: BASE_REV + 2 })]));
  assert.notEqual(newer.instruction.instructionId, first.instruction.instructionId);
  assert.deepEqual(newer.instruction.payloads, ["opsgp:CT007,AP001,SJ-01"]);
});

test("after the scan: waiting until a newer revision, then applied or drift", () => {
  const ready = evaluateSync(fresh(), opts([hb(["CT007"], 30)]));
  const acked = { ...ready, status: "awaiting_confirmation", instruction: { ...ready.instruction, acknowledgedAt: ago(20) } };
  assert.equal(evaluateSync(acked, opts([hb(["CT007"], 2)])).status, "awaiting_confirmation"); // later clock, same revision
  assert.equal(evaluateSync(acked, opts([])).status, "awaiting_confirmation"); // offline: not a failure
  assert.equal(evaluateSync(acked, opts([hb(["SJ-01"], 5, { evidenceRevision: BASE_REV + 2 })])).status, "applied");
  const drift = evaluateSync(acked, opts([hb(["CT007", "SJ-01"], 5, { evidenceRevision: BASE_REV + 2 })]));
  assert.deepEqual([drift.status, drift.instruction, drift.observed.codes], ["drift", undefined, ["CT007", "SJ-01"]]);
  assert.equal(evaluateSync(drift, opts([hb(["CT007", "SJ-01"], 5, { evidenceRevision: BASE_REV + 2 })])).status, "drift");
  const reissued = evaluateSync(drift, opts([hb(["CT007", "SJ-01"], 5, { evidenceRevision: BASE_REV + 2 })], { reissue: true }));
  assert.deepEqual([reissued.status, reissued.instruction.payloads], ["ready_to_sync", ["ops:CT007"]]);
});

test("unassignment: clearing codes is safe only for codes this machine was assigned, from qualifying evidence", () => {
  assert.deepEqual(evaluateSync(fresh([], false), opts([hb(["SJ-01"], 30)])).instruction.payloads, ["ops:SJ-01"]);
  assert.equal(evaluateSync(fresh([], false), opts([hb(["ZZ-9"], 30)])).status, "drift");
  assert.equal(evaluateSync(fresh([], false), opts([hb([], 30)])).status, "applied");
  assert.equal(evaluateSync(fresh([], false), opts([hb([], 30, { evidenceRevision: BASE_REV })])).status, "pending_device_state");
});

test("the sync state is bound to its assignment revision", () => {
  const s = fresh();
  assert.throws(() => evaluateSync(s, opts([hb(["CT007"], 30)], { revision: 4 })), /not for the current assignment revision/);
  const a = evaluateSync(s, opts([hb(["CT007"], 30)]));
  const b = evaluateSync({ ...s, forRevision: 4 }, opts([hb(["CT007"], 30)], { revision: 4 }));
  assert.notEqual(a.instruction.instructionId, b.instruction.instructionId);
});

test("more than eight toggles split into ordered barcodes, removals first", () => {
  const observed = ["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8"];
  assert.deepEqual(payloadsFor(computeDelta(observed, ["B1"], observed).toggles), ["opsgp:A1,A2,A3,A4,A5,A6,A7,A8", "ops:B1"]);
  assert.equal(computeDelta([], Array.from({ length: 9 }, (_, i) => `C${i}`), []).safe, false);
});

test("code rules: no separators, case-insensitive equality", () => {
  for (const bad of ["", "A,B", "A B", "ops:X", "x".repeat(33), "-X"]) assert.equal(validDeviceCode(bad), false, bad);
  for (const good of ["SJ-01", "CT007", "KUT004", "FRONT-JOIN", "a.b_c/d"]) assert.equal(validDeviceCode(good), true, good);
  assert.equal(sameCodes(["SJ-01"], ["sj-01"]), true);
  assert.equal(sameCodes(["SJ-01"], ["SJ-01", "CT007"]), false);
  assert.equal(observeDevice([hb(["CT007"], 30)], { machineId: M, baseline: { devices: [{ deviceId: "DEV-1", evidenceRevision: BASE_REV }] }, now: NOW, staleMs: STALE }).ok, true);
});
