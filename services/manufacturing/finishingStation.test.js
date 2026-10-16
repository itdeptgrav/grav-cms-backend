// node --test services/manufacturing/finishingStation.test.js
// The pure half of a hand scanner's pairing to a finishing dashboard: the
// QR token, the station key, the badge rules and the sign-in/out log.
"use strict";
process.env.JWT_SECRET = process.env.JWT_SECRET || "a-test-secret-that-is-long-enough-to-pass-the-fingerprint-check-0123456789";
const test = require("node:test");
const assert = require("node:assert/strict");
const st = require("./finishingStation");
const { STAGES } = require("./finishingStages");

const COMPANY = "6500000000000000000000aa";
const NOW = Date.parse("2026-10-16T09:00:00Z");

test("pair token: compact, round-trips, carries stage / company / issuer", () => {
  const m = st.mintPairToken({ stage: STAGES.ironing, companyId: COMPANY, issuedBy: { employeeId: "GR045", name: "Rakesh" }, now: NOW });
  assert.ok(m.text.startsWith("GRAVSTN:"));
  assert.ok(m.text.length <= 64, `QR payload ${m.text.length} chars — must stay a small QR`);
  assert.equal(m.expiresAt.getTime(), Math.floor((NOW + 10 * 60 * 1000) / 60000) * 60000);
  const r = st.readPairToken(m.text, NOW + 1000);
  assert.equal(r.stage.slug, "ironing");
  assert.equal(r.companyId, COMPANY);
  assert.equal(r.issuedBy.name, "GR045");
  assert.equal(st.readPairToken(m.token, NOW + 1000).stage.slug, "ironing", "with or without the prefix");
});

test("pair token: expired, tampered, foreign and malformed are refused", () => {
  const m = st.mintPairToken({ stage: STAGES.trimming, companyId: COMPANY, issuedBy: {}, now: NOW });
  assert.equal(st.readPairToken(m.text, NOW + 11 * 60 * 1000), null, "expired");
  assert.equal(st.readPairToken(m.text.replace("GRAVSTN:T.", "GRAVSTN:I."), NOW), null, "stage letter changed");
  assert.equal(st.readPairToken(m.text.slice(0, -1) + (m.text.endsWith("A") ? "B" : "A"), NOW), null, "signature changed");
  assert.equal(st.readPairToken("GRAVSTN:nonsense", NOW), null);
  assert.equal(st.readPairToken("", NOW), null);
  assert.equal(st.readPairToken("WO-abcdef12-001", NOW), null);
});

test("station key: bound to the device, distinct from a pair token", () => {
  const k = st.mintStationKey({ deviceId: "a1b2c3d4e5f6", stage: STAGES.ironing, companyId: COMPANY });
  const r = st.readStationKey(k.key);
  assert.equal(r.deviceId, "A1B2C3D4E5F6");
  assert.equal(r.stage.slug, "ironing");
  assert.equal(r.companyId, COMPANY);
  const pair = st.mintPairToken({ stage: STAGES.ironing, companyId: COMPANY, issuedBy: {}, now: NOW });
  assert.equal(st.readStationKey(pair.token), null, "a pair token is not a key");
  assert.equal(st.readPairToken(k.key, NOW), null, "a key is not a pair token");
});

test("badges and pieces", () => {
  assert.ok(st.isBadge("GR045")); assert.ok(st.isBadge("gr0045"));
  assert.ok(!st.isBadge("GR")); assert.ok(!st.isBadge("WO-abc-001")); assert.ok(!st.isBadge(""));
  assert.ok(st.isPieceBarcode("WO-abcdef12-001")); assert.ok(st.isPieceBarcode("wo-x-1"));
  assert.ok(!st.isPieceBarcode("GR045"));
});

test("applyOperatorEvent: sign in, repeat, takeover, sign out, bounded log", () => {
  const station = { operator: null, sessionLog: [] };
  const t = (m) => new Date(NOW + m * 60000);
  assert.equal(st.applyOperatorEvent(station, { type: "signout", badge: "GR045", at: t(0) }).changed, false, "signout with nobody in is a no-op");
  assert.equal(st.applyOperatorEvent(station, { type: "signin", badge: "gr045", person: { name: "RAKESH", userId: "u1", known: true }, at: t(1) }).changed, true);
  assert.equal(station.operator.badge, "GR045");
  assert.equal(station.operator.name, "RAKESH");
  assert.equal(st.applyOperatorEvent(station, { type: "signin", badge: "GR045", at: t(2) }).changed, false, "a retried signin is a no-op");
  assert.equal(station.sessionLog.length, 1);
  assert.equal(st.applyOperatorEvent(station, { type: "signin", badge: "GR0067", person: { name: "ANITA" }, at: t(3) }).changed, true, "takeover");
  assert.equal(station.operator.badge, "GR0067");
  assert.equal(station.sessionLog.length, 2);
  assert.equal(station.sessionLog[0].signedOutAt.getTime(), t(3).getTime(), "the first session closes at the takeover");
  assert.equal(st.applyOperatorEvent(station, { type: "signout", badge: "GR045", at: t(4) }).changed, false, "someone else's signout is ignored");
  assert.equal(st.applyOperatorEvent(station, { type: "signout", badge: "GR0067", at: t(5) }).changed, true);
  assert.equal(station.operator, null);
  assert.equal(station.sessionLog[1].signedOutAt.getTime(), t(5).getTime());
  for (let i = 0; i < 60; i++) {
    st.applyOperatorEvent(station, { type: "signin", badge: `GR${1000 + i}`, at: t(10 + i) });
    st.applyOperatorEvent(station, { type: "signout", badge: `GR${1000 + i}`, at: t(11 + i) });
  }
  assert.equal(station.sessionLog.length, st.SESSION_LOG_KEEP, "the log is a ring, not a collection");
});

test("doneByFor and isOnline", () => {
  assert.deepEqual(st.doneByFor({ userId: "u1", name: "RAKESH BISWAL", employeeId: "GR045", email: "r@grav.in", known: true }, "GR0045"), { userId: "u1", name: "RAKESH BISWAL", employeeId: "GR045", email: "r@grav.in", role: "operator" });
  assert.deepEqual(st.doneByFor(null, "gr9999"), { userId: "", name: "gr9999", employeeId: "GR9999", email: "", role: "operator (not in CMS)" });
  assert.equal(st.isOnline(new Date(NOW - 2 * 60000), NOW), true);
  assert.equal(st.isOnline(new Date(NOW - 4 * 60000), NOW), false);
  assert.equal(st.isOnline(null, NOW), false);
});
