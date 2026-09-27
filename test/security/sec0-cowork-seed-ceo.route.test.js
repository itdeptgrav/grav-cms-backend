// test/security/sec0-cowork-seed-ceo.route.test.js
//
// SEC-0 — nobody can create, overwrite or promote the CoWork CEO over HTTP.
//
// `POST /cowork/setup/seed-ceo` was public: it created or adopted a Firebase
// account, set the `ceo` custom claim and overwrote E000. It is removed, and
// the replacement is a local script (scripts/cowork/bootstrap-ceo.js) whose
// guard logic is tested here with in-memory fakes. Firebase is fully faked;
// nothing reaches Google.
"use strict";
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);
process.env.JWT_SECRET = "sec0-cowork-secret";

/* ── An in-memory Firebase, recording every mockPrivileged call ─────────────── */
const mockPrivileged = [];
const mockFirestore = new Map(); // "collection/id" -> data

function mockCollection(name) {
  const docsOf = () => [...mockFirestore.entries()]
    .filter(([k]) => k.startsWith(`${name}/`))
    .map(([k, data]) => ({ id: k.slice(name.length + 1), data: () => data, ref: mockDoc(name, k.slice(name.length + 1)) }));
  const query = (preds) => ({
    where: (f, op, v) => query([...preds, (d) => d[f] === v]),
    limit: () => query(preds),
    get: async () => {
      const docs = docsOf().filter((d) => preds.every((p) => p(d.data())));
      return { empty: docs.length === 0, docs, size: docs.length };
    },
  });
  return {
    ...query([]),
    doc: (id) => mockDoc(name, id),
    add: async (data) => { mockPrivileged.push([`add:${name}`, data]); mockFirestore.set(`${name}/auto${mockFirestore.size}`, data); return { id: "auto" }; },
  };
}
function mockDoc(name, id) {
  const key = `${name}/${id}`;
  return {
    get: async () => ({ exists: mockFirestore.has(key), id, data: () => mockFirestore.get(key) }),
    set: async (data, opts) => { mockPrivileged.push([`set:${key}`, data]); mockFirestore.set(key, { ...(opts?.merge ? mockFirestore.get(key) : {}), ...data }); },
    update: async (data) => { mockPrivileged.push([`update:${key}`, data]); mockFirestore.set(key, { ...mockFirestore.get(key), ...data }); },
    delete: async () => { mockPrivileged.push([`delete:${key}`]); mockFirestore.delete(key); },
    collection: (sub) => mockCollection(`${name}/${id}/${sub}`),
  };
}
const mockIdTokens = new Map(); // idToken -> { uid, email }
const mockAuth = {
  verifyIdToken: jest.fn(async (t) => { if (!mockIdTokens.has(t)) throw new Error("bad token"); return mockIdTokens.get(t); }),
  getUser: jest.fn(async (uid) => ({ uid, customClaims: {} })),
  getUserByEmail: jest.fn(async (email) => {
    const hit = [...mockIdTokens.values()].find((u) => u.email === email);
    if (!hit) throw Object.assign(new Error("no user"), { code: "auth/user-not-found" });
    return { uid: hit.uid, email };
  }),
  createUser: jest.fn(async () => { mockPrivileged.push(["createUser"]); return { uid: "created" }; }),
  setCustomUserClaims: jest.fn(async (uid, claims) => { mockPrivileged.push(["setCustomUserClaims", uid, claims]); }),
  revokeRefreshTokens: jest.fn(async (uid) => { mockPrivileged.push(["revokeRefreshTokens", uid]); }),
  updateUser: jest.fn(async () => { mockPrivileged.push(["updateUser"]); }),
};
const mockServerTimestamp = () => "SERVER_TS";
jest.mock("../../config/firebaseAdmin", () => ({
  auth: mockAuth,
  db: { collection: (n) => mockCollection(n), batch: () => ({ set() {}, update() {}, delete() {}, commit: async () => {} }) },
  admin: { firestore: { FieldValue: { serverTimestamp: mockServerTimestamp, arrayUnion: (...a) => a, arrayRemove: (...a) => a, increment: (n) => n, delete: () => null } } },
  messaging: { send: async () => ({}) },
  rtdb: { ref: () => ({ set: async () => {}, update: async () => {}, once: async () => ({ val: () => null }) }) },
}), { virtual: false });

/* services/cowork.service requires `uuid`, whose current release is ESM-only and
   cannot be loaded by this jest configuration. Node's own randomUUID is the
   same v4 contract. Scoped to this file. */
jest.mock("uuid", () => ({ v4: () => require("crypto").randomUUID() }));

const express = require("express");
const fs = require("fs");
const path = require("path");
const jwt = require("jsonwebtoken");

const { planBootstrap, runBootstrap } = require("../../scripts/cowork/bootstrap-ceo");

let server, base;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/cowork", require("../../routes/task_routes/cowork"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });
beforeEach(() => {
  mockPrivileged.length = 0;
  mockFirestore.clear();
  mockIdTokens.clear();
  require("../../Middlewear/coworkAuth").invalidateEmployeeCache();
  // An existing CEO and an ordinary employee, as a live workspace has.
  mockFirestore.set("cowork_employees/E000", { employeeId: "E000", authUid: "uid-ceo", role: "ceo", email: "ceo@grav.test", name: "CEO" });
  mockFirestore.set("cowork_employees/E010", { employeeId: "E010", authUid: "uid-emp", role: "employee", email: "emp@grav.test", name: "Emp" });
  mockIdTokens.set("id-token-employee", { uid: "uid-emp", email: "emp@grav.test" });
});

const post = (p, { headers = {}, body = {} } = {}) => fetch(`${base}${p}`, {
  method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

const attack = { email: "attacker@evil.test", password: "Attacker#12345", name: "Attacker" };
const ceoUnchanged = () => {
  expect(mockFirestore.get("cowork_employees/E000")).toMatchObject({ authUid: "uid-ceo", email: "ceo@grav.test" });
  expect(mockPrivileged.filter(([k]) => /createUser|setCustomUserClaims|set:cowork_employees\/E000/.test(k))).toEqual([]);
};

describe("POST /cowork/setup/seed-ceo no longer exists", () => {
  test("an anonymous caller cannot create or overwrite the CEO", async () => {
    const res = await post("/cowork/setup/seed-ceo", { body: attack });
    expect(res.status).toBe(404);
    ceoUnchanged();
  });

  test("an ordinary Firebase-authenticated employee cannot either", async () => {
    const res = await post("/cowork/setup/seed-ceo", { headers: { Authorization: "Bearer id-token-employee" }, body: attack });
    expect(res.status).toBe(404);
    ceoUnchanged();
  });

  test("an ordinary CMS session cannot either", async () => {
    const cms = jwt.sign({ v: 2, id: "x", email: "emp@grav.test", role: "sales", isAdmin: true }, process.env.JWT_SECRET);
    const res = await post("/cowork/setup/seed-ceo", { headers: { Authorization: `Bearer ${cms}` }, body: attack });
    expect(res.status).toBe(404);
    ceoUnchanged();
  });
});

describe("the remaining role-change route cannot promote to CEO", () => {
  test("an ordinary employee cannot promote anybody, CEO included", async () => {
    for (const role of ["ceo", "tl"]) {
      const res = await post("/cowork/employee/E010/change-role", {
        headers: { Authorization: "Bearer id-token-employee" }, body: { role },
      });
      expect([400, 403]).toContain(res.status);
    }
    ceoUnchanged();
    expect(mockFirestore.get("cowork_employees/E010").role).toBe("employee");
  });

  test("an anonymous caller is refused before anything else", async () => {
    const res = await post("/cowork/employee/E010/change-role", { body: { role: "ceo" } });
    expect(res.status).toBe(401);
    ceoUnchanged();
  });
});

test("no Express route anywhere declares a seed-ceo path", () => {
  const root = path.resolve(__dirname, "../..");
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".js")) {
        const text = fs.readFileSync(full, "utf8");
        if (/\.(get|post|put|patch|delete|all|use)\(\s*["'`][^"'`]*seed-ceo/.test(text)) offenders.push(path.relative(root, full));
      }
    }
  };
  walk(path.join(root, "routes"));
  if (/seed-ceo["'`]\s*,/.test(fs.readFileSync(path.join(root, "server.js"), "utf8"))) offenders.push("server.js");
  expect(offenders).toEqual([]);
});

/* ── The local bootstrap script ───────────────────────────────────────── */

describe("scripts/cowork/bootstrap-ceo.js", () => {
  const env = (extra = {}) => ({
    COWORK_BOOTSTRAP_CEO_EMAIL: "new.ceo@grav.test",
    COWORK_BOOTSTRAP_CEO_NAME: "New CEO",
    COWORK_BOOTSTRAP_CONFIRM: "new.ceo@grav.test",
    ...extra,
  });

  test("the plan refuses without explicit configuration and confirmation", () => {
    expect(planBootstrap({ env: {}, ceoExists: false, accountExists: true }).ok).toBe(false);
    expect(planBootstrap({ env: env({ COWORK_BOOTSTRAP_CONFIRM: "someone.else@grav.test" }), ceoExists: false, accountExists: true }).ok).toBe(false);
    expect(planBootstrap({ env: env({ COWORK_BOOTSTRAP_CEO_NAME: "" }), ceoExists: false, accountExists: true }).ok).toBe(false);
  });

  test("SEC-1: the plan refuses while any CEO exists, and no flag or variable bypasses it", () => {
    // SEC-0 briefly had a recovery mode (--recover + COWORK_BOOTSTRAP_RECOVERY);
    // SEC-1 removed it because it promoted a replacement without demoting the
    // old CEO. Every former override is proven inert here.
    const bypassEnv = env({ COWORK_BOOTSTRAP_RECOVERY: "replace-existing-ceo", COWORK_BOOTSTRAP_FORCE: "1" });
    for (const argv of [[], ["--recover"], ["--force"], ["--recover", "--force"]]) {
      for (const e of [env(), bypassEnv]) {
        expect(planBootstrap({ env: e, argv, ceoExists: true, accountExists: true }).ok).toBe(false);
      }
    }
    // Unknown CEO state is treated as "exists" — fail closed.
    expect(planBootstrap({ env: env(), ceoExists: undefined, accountExists: true }).ok).toBe(false);
    expect(planBootstrap({ env: env(), ceoExists: false, accountExists: true })).toEqual({ ok: true, action: "bootstrap-ceo" });
  });

  test("the plan never creates an account: a missing Firebase login is a refusal", () => {
    expect(planBootstrap({ env: env(), ceoExists: false, accountExists: false }).ok).toBe(false);
  });

  const db = { collection: (n) => mockCollection(n) };

  test("with a CEO present, a run refuses, changes nothing, and is audited", async () => {
    mockIdTokens.set("x", { uid: "uid-new", email: "new.ceo@grav.test" });
    const result = await runBootstrap({ env: env(), argv: [], auth: mockAuth, db, serverTimestamp: mockServerTimestamp });
    expect(result.ok).toBe(false);
    ceoUnchanged();
    const audits = mockPrivileged.filter(([k]) => k === "add:cowork_security_audit");
    expect(audits).toHaveLength(1);
    expect(audits[0][1]).toMatchObject({ kind: "cowork-ceo-bootstrap", ok: false, targetUid: null });
  });

  test("an empty workspace is bootstrapped from an EXISTING account, with no password anywhere", async () => {
    mockFirestore.delete("cowork_employees/E000");
    mockIdTokens.set("x", { uid: "uid-new", email: "new.ceo@grav.test" });
    const result = await runBootstrap({ env: env(), argv: [], auth: mockAuth, db, serverTimestamp: mockServerTimestamp });
    expect(result).toMatchObject({ ok: true, action: "bootstrap-ceo", target: "n***@grav.test" });
    expect(result).not.toHaveProperty("recovery");
    expect(mockAuth.createUser).not.toHaveBeenCalled();
    expect(mockAuth.setCustomUserClaims).toHaveBeenCalledWith("uid-new", { role: "ceo" });
    expect(mockFirestore.get("cowork_employees/E000")).toMatchObject({ authUid: "uid-new", role: "ceo" });
    const serialised = JSON.stringify({ result, mockPrivileged });
    expect(serialised).not.toMatch(/password|tempPassword/i);
    expect(mockPrivileged.some(([k]) => k === "add:cowork_security_audit")).toBe(true);
  });
});
