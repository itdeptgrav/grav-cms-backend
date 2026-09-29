"use strict";
/*
 * scripts/ie/ieDemoGuards.js
 *
 * THE REFUSALS THAT DECIDE WHETHER THIS SEEDER MAY RUN AT ALL.
 *
 * ── WHY THESE ARE STRICTER THAN THE HOUSE CONVENTION ────────────────────────
 * The existing `scripts/marketing/seed-demo.js` guards on
 * `NODE_ENV !== "production"` and `connection.name === "test"`. On this
 * checkout BOTH of those pass while pointing at the team's live MongoDB Atlas
 * cluster: `.env` sets `NODE_ENV=development`, and `MONGODB_URI` carries no
 * database path so Mongoose falls through to the default database named
 * `test`. A seeder trusting those two would cheerfully write demo companies,
 * demo users and demo work orders into the database the business runs on.
 *
 * So the host itself is checked, and an `mongodb+srv://` / `*.mongodb.net`
 * target is refused outright. A demo seeder has no business talking to a
 * managed cluster, and "it said development" is not evidence about which data
 * is on the other end of the socket.
 *
 * Every refusal below is a THROW, never a warning. A seeder that prints a
 * caution and continues is a seeder that ran.
 *
 * This file is new and development-only. It changes no application behaviour.
 */

const DEMO_TAG = "IE_DEMO_V1";
const OPT_IN = "IE_DEMO_SEED";
const PASSWORD_VAR = "IE_DEMO_PASSWORD";

/** Hosts that are somebody's real cluster, whatever NODE_ENV claims. */
function looksManaged(uri) {
  const s = String(uri || "").toLowerCase();
  return s.startsWith("mongodb+srv://")
    || s.includes(".mongodb.net")
    || s.includes("mongodb.com")
    || s.includes("documentdb")
    || s.includes("cosmos.azure");
}

/** Hosts a developer's own machine actually serves. */
function looksLocal(uri) {
  const s = String(uri || "").toLowerCase();
  return s.includes("://localhost")
    || s.includes("://127.0.0.1")
    || s.includes("://[::1]")
    || s.includes("://mongo:")        // docker-compose service name
    || s.includes("://mongodb:");
}

/**
 * May this process seed?
 *
 * @param {object} env   normally `process.env`
 * @param {string} uri   the connection string about to be used
 * @throws {Error} with a sentence naming the exact reason
 */
function assertSeedable(env, uri) {
  if (String(env.NODE_ENV || "").toLowerCase() === "production") {
    throw new Error("Refusing to seed: NODE_ENV is production.");
  }

  if (String(env[OPT_IN] || "") !== "1") {
    throw new Error(
      `Refusing to seed: set ${OPT_IN}=1 to opt in. This writes demo companies, `
      + "users, orders and styles.",
    );
  }

  if (!uri) {
    throw new Error("Refusing to seed: no MONGODB_URI was given.");
  }

  if (looksManaged(uri)) {
    throw new Error(
      "Refusing to seed: the connection string names a managed cluster "
      + "(mongodb+srv / mongodb.net). This seeder only writes to a local "
      + "development database. Point MONGODB_URI at a local replica set.",
    );
  }

  if (!looksLocal(uri)) {
    throw new Error(
      "Refusing to seed: the connection string is not a recognised local host. "
      + "Expected localhost, 127.0.0.1, ::1 or a docker mongo service.",
    );
  }

  const password = String(env[PASSWORD_VAR] || "");
  if (!password) {
    throw new Error(
      `Refusing to seed: set ${PASSWORD_VAR}. The demo password is never committed.`,
    );
  }
  if (password.length < 8) {
    throw new Error(`Refusing to seed: ${PASSWORD_VAR} must be at least 8 characters.`);
  }

  return { password };
}

/**
 * Release issuance is written inside one real transaction, which a standalone
 * mongod refuses. Checked up front so the scenario fails with a sentence
 * rather than half-built.
 */
function assertReplicaSet(available) {
  if (!available) {
    throw new Error(
      "Refusing to seed the release: this database has no transactions, so "
      + "`issueRelease` cannot run. Start mongod with --replSet, or run with "
      + "IE_DEMO_SKIP_RELEASE=1 to seed everything up to the approved capacity "
      + "standard and stop honestly there.",
    );
  }
}

/** Nothing that could carry a secret is ever printed. */
const SECRET_KEYS = /password|passwordhash|hash|token|secret|jwt|cookie|authorization/i;

function redact(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value !== "object") return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_KEYS.test(k) ? "[redacted]" : redact(v);
  }
  return out;
}

module.exports = {
  DEMO_TAG, OPT_IN, PASSWORD_VAR,
  looksManaged, looksLocal,
  assertSeedable, assertReplicaSet,
  redact, SECRET_KEYS,
};
