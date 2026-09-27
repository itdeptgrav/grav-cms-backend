// test/security/helpers/sec1-tasktree-harness.js
//
// Run by sec1-cowork-credential-exposure.route.test.js as a PLAIN NODE child
// process. routes/task_routes/taskTree.routes.js declares one function twice
// (pre-existing, valid sloppy-mode JavaScript that Node accepts) and jest's
// Babel transform refuses to parse it, so the router cannot be loaded inside
// jest. Here it is loaded by Node itself, with Firebase replaced by an
// in-memory fake injected into require.cache before anything requires it.
//
// Prints one JSON line: the HTTP results for the former dump paths and every
// Firestore document read the router performed.
"use strict";

const path = require("path");
const ROOT = path.resolve(__dirname, "../../..");

const reads = [];
const store = new Map([
  ["cowork_employees/E010", { employeeId: "E010", authUid: "uid-victim", gmailToken: { refresh_token: "1//PLANTED" }, tempPassword: "PLANTED" }],
  ["cowork_employees/E020", { employeeId: "E020", authUid: "uid-emp", role: "employee", name: "Ordinary", email: "emp@grav.test" }],
  ["cowork_tasks/T1", { taskId: "T1", secretNote: "PLANTED-TASK" }],
]);
function collection(name) {
  const query = (preds) => ({
    where: (f, op, v) => query([...preds, (d) => d[f] === v]),
    orderBy: () => query(preds),
    limit: () => query(preds),
    get: async () => {
      reads.push(`query:${name}`);
      const docs = [...store.entries()]
        .filter(([k]) => k.startsWith(`${name}/`))
        .map(([k, data]) => ({ id: k.split("/")[1], data: () => data, ref: doc(name, k.split("/")[1]) }))
        .filter((d) => preds.every((p) => p(d.data())));
      return { empty: docs.length === 0, docs };
    },
  });
  return { ...query([]), doc: (id) => doc(name, id) };
}
function doc(name, id) {
  const key = `${name}/${id}`;
  return {
    get: async () => { reads.push(`get:${key}`); return { exists: store.has(key), id, data: () => store.get(key) }; },
    set: async () => {}, update: async () => {}, delete: async () => {},
    collection: (sub) => collection(`${name}/${id}/${sub}`),
  };
}
const fake = {
  auth: {
    verifyIdToken: async (t) => { if (t !== "tok-emp") throw new Error("bad token"); return { uid: "uid-emp", email: "emp@grav.test" }; },
    getUser: async (uid) => ({ uid, customClaims: {} }),
  },
  db: { collection, batch: () => ({ set() {}, update() {}, delete() {}, commit: async () => {} }) },
  admin: { firestore: { FieldValue: { serverTimestamp: () => "TS", arrayUnion: (...a) => a, arrayRemove: (...a) => a, increment: (n) => n } } },
  messaging: { send: async () => ({}) },
  rtdb: { ref: () => ({ set: async () => {}, update: async () => {}, once: async () => ({ val: () => null }) }) },
};
const fbPath = require.resolve(path.join(ROOT, "config/firebaseAdmin"));
require.cache[fbPath] = { id: fbPath, filename: fbPath, loaded: true, exports: fake };

(async () => {
  const express = require(path.join(ROOT, "node_modules/express"));
  const router = require(path.join(ROOT, "routes/task_routes/taskTree.routes.js"));
  const app = express();
  app.use(express.json());
  app.use("/cowork", router);
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;

  const declared = router.stack
    .filter((l) => l.route)
    .map((l) => `${Object.keys(l.route.methods).join(",").toUpperCase()} ${l.route.path}`);

  const results = [];
  for (const p of ["/cowork/task/dump/T1", "/cowork/employee/dump/E010"]) {
    for (const token of [null, "tok-emp"]) {
      const res = await fetch(`${base}${p}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      const text = await res.text();
      results.push({ path: p, withSession: Boolean(token), status: res.status, leaked: /PLANTED|uid-victim/.test(text) });
    }
  }
  server.close();
  process.stdout.write(JSON.stringify({ results, reads, declared }) + "\n");
  process.exit(0);
})().catch((err) => {
  process.stdout.write(JSON.stringify({ error: String(err && err.stack || err) }) + "\n");
  process.exit(1);
});
