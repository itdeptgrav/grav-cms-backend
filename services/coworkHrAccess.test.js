// services/coworkHrAccess.test.js — node --test services/coworkHrAccess.test.js
//
// Inactive in HR → no CoWork access, nothing deleted; active again → access
// back. Fakes stand in for Firestore, Firebase Auth and the HR model, so this
// touches no real account.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const A = require("./coworkHrAccess.service");

/* ── FAKES ─────────────────────────────────────────────────────────────── */

function fakeDb(docs) {
  const store = new Map(Object.entries(docs).map(([k, v]) => [k, { ...v }]));
  const ref = (id) => ({
    id,
    get: async () => ({ id, exists: store.has(id), data: () => (store.has(id) ? { ...store.get(id) } : undefined) }),
    set: async (patch, opts) => store.set(id, opts?.merge ? { ...(store.get(id) || {}), ...patch } : { ...patch }),
  });
  const col = {
    doc: ref,
    where: (field, op, val) => ({
      get: async () => ({ docs: [...store].filter(([, d]) => d[field] === val).map(([id, d]) => ({ id, data: () => ({ ...d }) })) }),
    }),
  };
  return { collection: () => col, store };
}

function fakeAuth(users) {
  const byUid = new Map(users.map((u) => [u.uid, { disabled: false, ...u }]));
  const revoked = [];
  const missing = () => Object.assign(new Error("no user"), { code: "auth/user-not-found" });
  return {
    byUid, revoked,
    getUser: async (uid) => { if (!byUid.has(uid)) throw missing(); return { ...byUid.get(uid) }; },
    getUserByEmail: async (email) => { for (const u of byUid.values()) if (u.email === email) return { ...u }; throw missing(); },
    updateUser: async (uid, patch) => { if (!byUid.has(uid)) throw missing(); Object.assign(byUid.get(uid), patch); },
    revokeRefreshTokens: async (uid) => { if (!byUid.has(uid)) throw missing(); revoked.push(uid); },
  };
}

/* A tiny Mongo matcher: enough for the $or of $in / RegExp the service sends. */
function matches(rec, cond) {
  return Object.entries(cond).every(([k, v]) => {
    const val = rec[k];
    if (v instanceof RegExp) return typeof val === "string" && v.test(val);
    if (v && Array.isArray(v.$in)) return v.$in.includes(val);
    return val === v;
  });
}
function fakeEmployee(records, { fail = false } = {}) {
  return {
    records,
    find(q) {
      return { select() { return { lean: async () => { if (fail) throw new Error("mongo down"); return records.filter((r) => q.$or.some((c) => matches(r, c))); } }; } };
    },
  };
}

const hr = (over) => ({ _id: `hr-${Math.random().toString(36).slice(2)}`, firstName: "Asfiya", lastName: "Batul", isActive: true, status: "active", ...over });

function world({ docs, users, hrRecords, fail }) {
  const db = fakeDb(docs);
  const auth = fakeAuth(users);
  const Employee = fakeEmployee(hrRecords, { fail });
  const changed = [];
  const svc = A.createCoworkHrAccess({ db, auth, Employee, now: () => new Date("2026-10-12T09:00:00Z"), onAccessChanged: (uid) => changed.push(uid) });
  return { db, auth, Employee, svc, changed };
}

/* ── THE RULES ─────────────────────────────────────────────────────────── */

test("HR's rule: inactive is isActive false OR status inactive; HR standing needs EVERY linked record gone", () => {
  assert.equal(A.hasLeft({ isActive: false, status: "active" }), true);
  assert.equal(A.hasLeft({ isActive: true, status: "Inactive" }), true);
  assert.equal(A.hasLeft({ isActive: true, status: "active" }), false);
  assert.equal(A.hrStanding([]), "none");
  assert.equal(A.hrStanding([hr({ isActive: false })]), "inactive");
  /* a re-hire: the old record left, the new one is active */
  assert.equal(A.hrStanding([hr({ isActive: false, status: "inactive" }), hr()]), "active");
});

test("an account links to HR by the explicit link, the biometric id, its employeeId, or the work/personal email", () => {
  const a = hr({ coworkEmployeeId: "E014" });
  const b = hr({ biometricId: "GR0124" });
  const c = hr({ biometricId: "GR0050" });
  const d = hr({ personalEmail: "Asfiya@Gmail.com" });
  const index = A.buildHrIndex([a, b, c, d]);
  assert.deepEqual(A.linkedHrFor(index, "E014", {}).map((x) => x._id), [a._id]);
  assert.deepEqual(A.linkedHrFor(index, "GR0124", {}).map((x) => x._id), [b._id]);
  assert.deepEqual(A.linkedHrFor(index, "E099", { employeeId: "GR0050" }).map((x) => x._id), [c._id]);
  assert.deepEqual(A.linkedHrFor(index, "E100", { email: "asfiya@gmail.com" }).map((x) => x._id), [d._id]);
  assert.deepEqual(A.linkedHrFor(index, "E200", { email: "nobody@x.com" }), []);
  assert.equal(A.hrQueryFor([]), null);
});

/* ── HR TURNS SOMEBODY INACTIVE ────────────────────────────────────────── */

test("inactive in HR: the CoWork record is MARKED (nothing removed), the login disabled and every session revoked", async () => {
  const emp = hr({ biometricId: "GR0124", email: "asfiyabatul362@gmail.com", isActive: false, status: "inactive" });
  const w = world({
    docs: { GR0124: { employeeId: "GR0124", name: "ASFIYA BATUL", email: "asfiyabatul362@gmail.com", department: "Designing", role: "employee", authUid: "u1" } },
    users: [{ uid: "u1", email: "asfiyabatul362@gmail.com" }],
    hrRecords: [emp],
  });
  const out = await w.svc.syncEmployee(emp, { by: "HR Manager" });
  assert.deepEqual(out.deactivated.map((d) => d.id), ["GR0124"]);
  const doc = w.db.store.get("GR0124");
  assert.equal(doc.status, "inactive");
  assert.equal(doc.isActive, false);
  assert.equal(doc.hrInactive, true);
  assert.equal(doc.deactivatedReason, A.HR_REASON);
  assert.equal(doc.deactivatedBy, "HR Manager");
  assert.equal(doc.firebaseDisabledByHr, true);
  /* kept as it was */
  assert.equal(doc.name, "ASFIYA BATUL");
  assert.equal(doc.department, "Designing");
  assert.equal(w.db.store.size, 1);
  assert.equal(w.auth.byUid.get("u1").disabled, true);
  assert.deepEqual(w.auth.revoked, ["u1"]);
  assert.deepEqual(w.changed, ["u1"]);
});

test("a second sync of an already-inactive account changes nothing", async () => {
  const emp = hr({ biometricId: "GR0124", isActive: false });
  const w = world({ docs: { GR0124: { authUid: "u1", status: "inactive", isActive: false, hrInactive: true } }, users: [{ uid: "u1", disabled: true }], hrRecords: [emp] });
  const out = await w.svc.syncEmployee(emp);
  assert.deepEqual(out.unchanged, ["GR0124"]);
  assert.deepEqual(w.auth.revoked, []);
});

test("an account whose OTHER linked HR record is active is not switched off", async () => {
  const old = hr({ biometricId: "GR0010", isActive: false, status: "inactive", email: "ravi@grav.in" });
  const current = hr({ biometricId: "GR0140", email: "ravi@grav.in" });
  const w = world({ docs: { GR0140: { email: "ravi@grav.in", authUid: "u2" } }, users: [{ uid: "u2" }], hrRecords: [old, current] });
  const out = await w.svc.syncEmployee(old);
  assert.equal(out.deactivated.length, 0);
  assert.equal(w.auth.byUid.get("u2").disabled, false);
});

test("an account with no authUid is found in Firebase by its email", async () => {
  const emp = hr({ biometricId: "GR0121", isActive: false });
  const w = world({ docs: { GR0121: { email: "sangeeta@x.com" } }, users: [{ uid: "u9", email: "sangeeta@x.com" }], hrRecords: [emp] });
  await w.svc.syncEmployee(emp);
  assert.equal(w.auth.byUid.get("u9").disabled, true);
});

/* ── ACTIVE AGAIN ──────────────────────────────────────────────────────── */

test("active again in HR: the record reads active and the login HR switched off is switched back on", async () => {
  const emp = hr({ biometricId: "GR0124" });
  const w = world({
    docs: { GR0124: { authUid: "u1", status: "inactive", isActive: false, hrInactive: true, firebaseDisabledByHr: true, deactivatedAt: "2026-10-01T00:00:00.000Z" } },
    users: [{ uid: "u1", disabled: true }],
    hrRecords: [emp],
  });
  const out = await w.svc.syncEmployee(emp, { by: "HR Manager" });
  assert.deepEqual(out.reactivated.map((d) => d.id), ["GR0124"]);
  const doc = w.db.store.get("GR0124");
  assert.equal(doc.status, "active");
  assert.equal(doc.isActive, true);
  assert.equal(doc.hrInactive, false);
  assert.equal(doc.reactivatedBy, "HR Manager");
  assert.equal(doc.deactivatedAt, "2026-10-01T00:00:00.000Z");   // the history stays
  assert.equal(w.auth.byUid.get("u1").disabled, false);
});

test("a login disabled for some OTHER reason stays disabled when HR reactivates", async () => {
  const emp = hr({ biometricId: "GR0124", isActive: false });
  const w = world({ docs: { GR0124: { authUid: "u1" } }, users: [{ uid: "u1", disabled: true }], hrRecords: [emp] });
  await w.svc.syncEmployee(emp);
  assert.equal(w.db.store.get("GR0124").firebaseDisabledByHr, false);
  emp.isActive = true; emp.status = "active";
  await w.svc.syncEmployee(emp);
  assert.equal(w.auth.byUid.get("u1").disabled, true);
  assert.equal(w.db.store.get("GR0124").status, "active");
});

test("a CoWork record nobody marked through HR is never 'reactivated' by HR", async () => {
  const emp = hr({ biometricId: "GR0124" });
  const w = world({ docs: { GR0124: { authUid: "u1", status: "inactive", isActive: false } }, users: [{ uid: "u1" }], hrRecords: [emp] });
  const out = await w.svc.syncEmployee(emp);
  assert.equal(out.reactivated.length, 0);
  assert.equal(w.db.store.get("GR0124").status, "inactive");
});

/* ── THE TOKEN CHECK ───────────────────────────────────────────────────── */

test("a record marked inactive is refused without asking HR", async () => {
  const w = world({ docs: {}, users: [], hrRecords: [], fail: true });
  const r = await w.svc.refusalFor("GR0124", { status: "inactive" });
  assert.deepEqual(r, { code: A.CODE, message: A.MESSAGE });
  assert.match(A.MESSAGE, /inactive in HR/);
});

test("somebody inactive in HR before this existed is refused, and their record and login are brought into line", async () => {
  const w = world({ docs: { GR0124: { authUid: "u1", email: "a@x.com" } }, users: [{ uid: "u1" }], hrRecords: [hr({ biometricId: "GR0124", isActive: false })] });
  const r = await w.svc.refusalFor("GR0124", { authUid: "u1", email: "a@x.com" });
  assert.equal(r.code, "EMPLOYEE_INACTIVE");
  await new Promise((done) => setTimeout(done, 10));
  assert.equal(w.db.store.get("GR0124").status, "inactive");
  assert.equal(w.auth.byUid.get("u1").disabled, true);
});

test("active in HR, no HR record, or HR unreachable: allowed", async () => {
  const active = world({ docs: {}, users: [], hrRecords: [hr({ biometricId: "GR0099" })] });
  assert.equal(await active.svc.refusalFor("GR0099", {}), null);
  const none = world({ docs: {}, users: [], hrRecords: [] });
  assert.equal(await none.svc.refusalFor("E000", { email: "ceo@grav.in" }), null);
  const down = world({ docs: {}, users: [], hrRecords: [], fail: true });
  assert.equal(await down.svc.refusalFor("GR0099", {}), null);
});

/* ── THE DIRECTORY ─────────────────────────────────────────────────────── */

test("the directory marks HR-inactive people inactive and removes nobody", async () => {
  const w = world({ docs: {}, users: [], hrRecords: [hr({ biometricId: "GR0124", isActive: false }), hr({ biometricId: "GR0099" })] });
  const out = await w.svc.markDirectory([
    { id: "GR0124", name: "ASFIYA BATUL" },
    { id: "GR0099", name: "ANANTA" },
    { id: "E000", name: "CEO" },
    { id: "GR0007", name: "OLD", status: "inactive" },
  ]);
  assert.deepEqual(out.map((e) => [e.id, e.status || "", e.isActive ?? null]), [
    ["GR0124", "inactive", false], ["GR0099", "", null], ["E000", "", null], ["GR0007", "inactive", false],
  ]);
  const down = world({ docs: {}, users: [], hrRecords: [], fail: true });
  assert.equal((await down.svc.markDirectory([{ id: "X" }])).length, 1);
});
