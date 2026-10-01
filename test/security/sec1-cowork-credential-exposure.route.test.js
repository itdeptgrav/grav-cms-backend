// test/security/sec1-cowork-credential-exposure.route.test.js
//
// SEC-1 — CoWork no longer hands one person's credentials to another.
//
//   · the three public debug dumps are gone (404) and read nothing;
//   · every directory / member-list response is an ALLOWLIST projection, so a
//     planted Gmail token, temporary password, Firebase uid, push token,
//     custom claims, reset code, session/API token or an unknown future field
//     never leaves the server — while the fields the directory needs remain.
//
// Firebase is an in-memory fake that records every document read.
"use strict";
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);
process.env.JWT_SECRET = "sec1-cowork-secret";

const mockReads = [];
const mockStore = new Map(); // "collection/id" -> data

function mockCollection(name) {
  const docsOf = () => [...mockStore.entries()]
    .filter(([k]) => k.startsWith(`${name}/`) && !k.slice(name.length + 1).includes("/"))
    .map(([k, data]) => ({ id: k.slice(name.length + 1), exists: true, data: () => data, ref: mockDoc(name, k.slice(name.length + 1)) }));
  const query = (preds) => ({
    where: (f, op, v) => query([...preds, (d) => (op === "array-contains" ? (d[f] || []).includes(v) : d[f] === v)]),
    orderBy: () => query(preds),
    limit: () => query(preds),
    get: async () => {
      mockReads.push(`query:${name}`);
      const docs = docsOf().filter((d) => preds.every((p) => p(d.data())));
      return { empty: docs.length === 0, docs, size: docs.length, forEach: (fn) => docs.forEach(fn) };
    },
  });
  return { ...query([]), doc: (id) => mockDoc(name, id), add: async () => ({ id: "auto" }) };
}
function mockDoc(name, id) {
  const key = `${name}/${id}`;
  return {
    get: async () => { mockReads.push(`get:${key}`); return { exists: mockStore.has(key), id, data: () => mockStore.get(key), ref: mockDoc(name, id) }; },
    set: async (d) => { mockStore.set(key, { ...(mockStore.get(key) || {}), ...d }); },
    update: async (d) => { mockStore.set(key, { ...(mockStore.get(key) || {}), ...d }); },
    delete: async () => { mockStore.delete(key); },
    collection: (sub) => mockCollection(`${name}/${id}/${sub}`),
  };
}
const mockIdTokens = new Map();
jest.mock("../../config/firebaseAdmin", () => ({
  auth: {
    verifyIdToken: async (t) => { if (!mockIdTokens.has(t)) throw new Error("bad token"); return mockIdTokens.get(t); },
    getUser: async (uid) => ({ uid, customClaims: {} }),
  },
  db: { collection: (n) => mockCollection(n), batch: () => ({ set() {}, update() {}, delete() {}, commit: async () => {} }) },
  admin: { firestore: { FieldValue: { serverTimestamp: () => "TS", arrayUnion: (...a) => a, arrayRemove: (...a) => a, increment: (n) => n, delete: () => null } } },
  messaging: { send: async () => ({}) },
  rtdb: { ref: () => ({ set: async () => {}, update: async () => {}, once: async () => ({ val: () => null }) }) },
}));
// services/cowork.service requires ESM-only `uuid`; Node's randomUUID is the same v4 contract.
jest.mock("uuid", () => ({ v4: () => require("crypto").randomUUID() }));

const express = require("express");

const PLANTED = {
  gmailToken: { refresh_token: "1//PLANTED-REFRESH", access_token: "ya29.PLANTED-ACCESS", connectedEmail: "victim@gmail.test" },
  googleTokens: { refresh_token: "1//PLANTED-REFRESH-2" },
  tempPassword: "PlantedTemp#123",
  password: "PlantedPassword#1",
  passwordHash: "$2b$10$PLANTEDHASH",
  passwordResetOtp: "PLANTED-OTP-4242",
  resetToken: "PLANTED-RESET",
  authUid: "uid-PLANTED-victim",
  customClaims: { role: "ceo", planted: true },
  fcmTokens: ["PLANTED-FCM-1"],
  webPushSubscription: { endpoint: "https://push.test/PLANTED" },
  sessionToken: "PLANTED-SESSION",
  apiKey: "PLANTED-API-KEY",
  secretConfig: { key: "PLANTED-CONFIG" },
  someFutureField: "PLANTED-FUTURE-FIELD",
};
const SECRET_KEYS = Object.keys(PLANTED);
const SECRET_VALUES = /PLANTED|uid-PLANTED|victim@gmail\.test/;

const VICTIM = {
  employeeId: "E010", name: "Victim Person", email: "victim@grav.test", mobile: "9000000010",
  city: "Chennai", department: "Design", role: "employee", profilePicUrl: "https://img.test/v.png",
  passwordChanged: true, createdAt: "TS", ...PLANTED,
};
const REQUIRED = { employeeId: "E010", name: "Victim Person", email: "victim@grav.test", mobile: "9000000010",
  city: "Chennai", department: "Design", role: "employee", profilePicUrl: "https://img.test/v.png", passwordChanged: true };

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
  mockReads.length = 0;
  mockStore.clear();
  mockIdTokens.clear();
  require("../../Middlewear/coworkAuth").invalidateEmployeeCache();
  require("../../services/cowork.service").invalidateEmpListCache();
  mockStore.set("cowork_employees/E000", { employeeId: "E000", authUid: "uid-ceo", role: "ceo", name: "CEO", email: "ceo@grav.test" });
  mockStore.set("cowork_employees/E010", { ...VICTIM });
  mockStore.set("cowork_employees/E020", { employeeId: "E020", authUid: "uid-emp", role: "employee", name: "Ordinary", email: "emp@grav.test", department: "Design" });
  mockStore.set("cowork_employees/E030", { employeeId: "E030", authUid: "uid-tl", role: "tl", name: "Team Lead", email: "tl@grav.test", department: "Design" });
  mockStore.set("cowork_tasks/T1", { taskId: "T1", title: "Private task", secretNote: "PLANTED-TASK" });
  mockStore.set("cowork_groups/G1", { name: "Design", memberIds: ["E010", "E020"], createdBy: "E030" });
  mockIdTokens.set("tok-emp", { uid: "uid-emp", email: "emp@grav.test" });
  mockIdTokens.set("tok-tl", { uid: "uid-tl", email: "tl@grav.test" });
  mockIdTokens.set("tok-ceo", { uid: "uid-ceo", email: "ceo@grav.test" });
});

const get = (p, token) => fetch(`${base}${p}`, {
  headers: token ? { Authorization: `Bearer ${token}` } : {},
}).then(async (r) => { const text = await r.text(); let body = null; try { body = JSON.parse(text); } catch { /* html 404 */ } return { status: r.status, text, body }; });

/** A directory entry must carry what the directory needs, and nothing secret or unknown. */
function assertSafeEntry(entry) {
  expect(entry).toMatchObject(REQUIRED);
  for (const key of SECRET_KEYS) expect(Object.keys(entry)).not.toContain(key);
  expect(JSON.stringify(entry)).not.toMatch(SECRET_VALUES);
}

/* ══ 1. The debug dumps are gone ═════════════════════════════════════════ */

describe("former debug dump routes", () => {
  /* taskTree.routes.js is loaded by plain Node in a child process: it declares
     one function twice (pre-existing, valid for Node) and jest's Babel parser
     refuses the file. See test/security/helpers/sec1-tasktree-harness.js. */
  let harness;
  beforeAll(() => {
    const { spawnSync } = require("child_process");
    const path = require("path");
    const out = spawnSync(process.execPath, [path.join(__dirname, "helpers/sec1-tasktree-harness.js")], {
      env: { ...process.env }, encoding: "utf8", timeout: 60000,
    });
    const line = String(out.stdout || "").trim().split("\n").pop();
    harness = JSON.parse(line || "{}");
  });

  test("the harness loaded the real taskTree router", () => {
    expect(harness.error).toBeUndefined();
    expect(harness.declared.length).toBeGreaterThan(10);
  });

  test("no /dump route is declared on the mounted taskTree router", () => {
    expect(harness.declared.filter((r) => /\/dump/.test(r))).toEqual([]);
  });

  test.each([
    ["/cowork/task/dump/T1", false], ["/cowork/task/dump/T1", true],
    ["/cowork/employee/dump/E010", false], ["/cowork/employee/dump/E010", true],
  ])("%s (ordinary session: %s) answers 404 and leaks nothing", (p, withSession) => {
    const r = harness.results.find((x) => x.path === p && x.withSession === withSession);
    expect(r).toEqual({ path: p, withSession, status: 404, leaked: false });
  });

  test("the dump paths read no Firestore document", () => {
    expect(harness.reads.filter((r) => /cowork_tasks\/T1|cowork_employees\/E010/.test(r))).toEqual([]);
  });

  test("no router file still declares a /dump route", () => {
    const fs = require("fs");
    const path = require("path");
    const dir = path.resolve(__dirname, "../../routes");
    const offenders = [];
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".js") && /router\.(get|post|put|patch|delete|all)\(\s*["'`][^"'`]*\/dump/.test(fs.readFileSync(full, "utf8"))) offenders.push(full);
    });
    walk(dir);
    expect(offenders).toEqual([]);
  });
});

/* ══ 2. Directory and member-list responses are allowlist projections ═════ */

describe("directory responses never carry credentials or unknown fields", () => {
  test("GET /cowork/employee/list-members (any employee)", async () => {
    const res = await get("/cowork/employee/list-members", "tok-emp");
    expect(res.status).toBe(200);
    const victim = res.body.employees.find((e) => e.employeeId === "E010");
    assertSafeEntry(victim);
    expect(res.text).not.toMatch(SECRET_VALUES);
    // authUid is dropped for everybody, not only the planted row.
    for (const e of res.body.employees) expect(e).not.toHaveProperty("authUid");
  });

  test("GET /cowork/employee/list (TL / CEO)", async () => {
    for (const token of ["tok-tl", "tok-ceo"]) {
      require("../../services/cowork.service").invalidateEmpListCache();
      const res = await get("/cowork/employee/list", token);
      expect(res.status).toBe(200);
      assertSafeEntry(res.body.employees.find((e) => e.employeeId === "E010"));
      expect(res.text).not.toMatch(SECRET_VALUES);
    }
  });

  test("GET /cowork/employee/:id (another employee's record)", async () => {
    const res = await get("/cowork/employee/E010", "tok-emp");
    expect(res.status).toBe(200);
    assertSafeEntry(res.body.employee);
    expect(res.text).not.toMatch(SECRET_VALUES);
  });

  test("GET /cowork/group/:groupId members", async () => {
    const res = await get("/cowork/group/G1", "tok-emp");
    expect(res.status).toBe(200);
    const victim = res.body.group.members.find((m) => m.employeeId === "E010");
    assertSafeEntry(victim);
    expect(res.text).not.toMatch(SECRET_VALUES);
  });

  test("listAllEmployees (exported, currently unrouted) is projected too", async () => {
    const { listAllEmployees } = require("../../services/coworkEnhanced.service");
    const rows = await listAllEmployees("E020");
    assertSafeEntry(rows.find((e) => e.employeeId === "E010"));
    expect(JSON.stringify(rows)).not.toMatch(SECRET_VALUES);
  });

  test("the projector keeps only allowlisted keys, whatever the document holds", () => {
    const { toDirectoryEmployee, DIRECTORY_FIELDS } = require("../../services/coworkEmployeeProjection");
    const out = toDirectoryEmployee({ id: "E010", ...VICTIM, isActive: true, status: "active", nested: { a: 1 } });
    expect(Object.keys(out).every((k) => DIRECTORY_FIELDS.includes(k))).toBe(true);
    assertSafeEntry(out);
    // A secret smuggled under an allowlisted name in the wrong type is dropped.
    expect(toDirectoryEmployee({ name: { refresh_token: "PLANTED" } })).toEqual({});
  });

  test("the self /me contract is unchanged and carries no other person's data", async () => {
    const res = await get("/cowork/me", "tok-emp");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ employeeId: "E020", authUid: "uid-emp", role: "employee" });
    expect(res.text).not.toMatch(SECRET_VALUES);
  });
});
