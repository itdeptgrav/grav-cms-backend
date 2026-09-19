const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  coworkDbChoice,
  servesChangeStreams,
} = require("./coworkDbChoice");

/**
 * The cutover switch, and the guard that stops it being set wrongly.
 *
 * Both halves matter and they fail differently. Choosing the wrong database is
 * loud — nothing works. Choosing the right database on a server that cannot
 * serve change streams is SILENT: reads and writes are fine, and only realtime
 * is dead, which looks like a frontend bug for as long as it takes somebody to
 * think of the database.
 */

/* ── Default: nothing changes ─────────────────────────────────────────────── */

test("an unset variable means Firestore, unchanged", () => {
  /* The default has to be the old world. A migration that flips on by accident
     is not reversible in any useful sense. */
  assert.deepEqual(coworkDbChoice({}), { useMongo: false, uri: null, dbName: null });
});

test("anything that is not exactly 'mongo' means Firestore", () => {
  for (const v of ["", "firestore", "mongodb", "MONGO_DB", "1", "true", "no"])
    assert.equal(coworkDbChoice({ COWORK_DB: v }).useMongo, v.toLowerCase() === "mongo");
});

test("the value is read case-insensitively", () => {
  const env = { COWORK_DB: "MONGO", COWORK_MONGODB_URI: "mongodb+srv://x/y" };
  assert.equal(coworkDbChoice(env).useMongo, true);
});

/* ── The replica-set guard ────────────────────────────────────────────────── */

test("a standalone URI is refused, with instructions", () => {
  /* This is the whole point of the guard. A standalone mongod accepts the
     connection and serves every read and write — it fails only at watch(), by
     which time realtime is dead and nobody has been told. */
  assert.throws(
    () =>
      coworkDbChoice({
        COWORK_DB: "mongo",
        COWORK_MONGODB_URI: "mongodb://127.0.0.1:27017/cowork",
      }),
    /replica set[\s\S]*rs\.initiate/i,
  );
});

test("a replica-set URI is accepted", () => {
  const c = coworkDbChoice({
    COWORK_DB: "mongo",
    COWORK_MONGODB_URI: "mongodb://127.0.0.1:27017/cowork?replicaSet=rs0",
  });
  assert.equal(c.useMongo, true);
  assert.match(c.uri, /replicaSet=rs0/);
});

test("Atlas is accepted, because srv is always a replica set", () => {
  assert.equal(servesChangeStreams("mongodb+srv://user:pw@cluster.example.net/cowork"), true);
});

test("directConnection=true is refused even alongside replicaSet", () => {
  /* It pins the driver to one node and disables the topology discovery change
     streams need — a URI asking for both is asking for two incompatible
     things, and the combination reads as correct at a glance. */
  assert.equal(
    servesChangeStreams("mongodb://127.0.0.1:27017/c?replicaSet=rs0&directConnection=true"),
    false,
  );
  assert.throws(
    () =>
      coworkDbChoice({
        COWORK_DB: "mongo",
        COWORK_MONGODB_URI: "mongodb://127.0.0.1:27017/c?replicaSet=rs0&directConnection=true",
      }),
    /replica set/i,
  );
});

test("an empty replicaSet value does not count", () => {
  assert.equal(servesChangeStreams("mongodb://h/c?replicaSet="), false);
});

/* ── The URI itself ───────────────────────────────────────────────────────── */

test("mongo with no URI at all says which variables to set", () => {
  assert.throws(
    () => coworkDbChoice({ COWORK_DB: "mongo" }),
    /COWORK_MONGODB_URI.*MONGODB_URI/,
  );
});

test("COWORK_MONGODB_URI wins over MONGODB_URI", () => {
  /* MONGODB_URI is the ERP's database — the CMS, payroll, inventory. Falling
     back to it is a convenience for a single-database deployment, but an
     explicit Cowork URI must always take precedence or a shared-cluster setup
     would quietly write Cowork data into the ERP database. */
  const c = coworkDbChoice({
    COWORK_DB: "mongo",
    COWORK_MONGODB_URI: "mongodb://cowork-host/c?replicaSet=rs0",
    MONGODB_URI: "mongodb://erp-host/grav_clothing?replicaSet=rs0",
  });
  assert.match(c.uri, /cowork-host/);
});

test("the database name defaults to cowork, and is overridable", () => {
  const base = { COWORK_DB: "mongo", COWORK_MONGODB_URI: "mongodb+srv://h/x" };
  assert.equal(coworkDbChoice(base).dbName, "cowork");
  assert.equal(coworkDbChoice({ ...base, COWORK_MONGODB_DB: "cowork_staging" }).dbName, "cowork_staging");
});

/* ── The wiring that uses it ──────────────────────────────────────────────── */

test("config/firebaseAdmin reads the choice from here, not from its own parsing", () => {
  /* Two copies of this rule would drift, and the drift would show up as a
     server that boots happily onto a database that cannot serve realtime. */
  const src = require("node:fs")
    .readFileSync(require.resolve("../../config/firebaseAdmin.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(src, /coworkDbChoice\(process\.env\)/);
  assert.equal(
    /COWORK_DB\s*\|\|\s*""/.test(src),
    false,
    "firebaseAdmin.js parses COWORK_DB itself again",
  );
});

test("Firebase auth and messaging are still exported unchanged", () => {
  /* Authentication is NOT part of this migration. */
  const src = require("node:fs").readFileSync(
    require.resolve("../../config/firebaseAdmin.js"),
    "utf8",
  );
  assert.match(src, /const auth = admin\.auth\(\);/);
  assert.match(src, /const messaging = admin\.messaging\(\);/);
  assert.match(src, /module\.exports = \{ admin, db, auth, messaging, rtdb, useMongo \}/);
});
