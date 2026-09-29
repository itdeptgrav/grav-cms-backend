// test/reporting/readonly-role.test.js
//
// THE METABASE CONNECTION IS READ-ONLY — asserted in CI, not once by hand.
//
// This runs the same probe list as `npm run reporting:verify-roles`
// (services/reporting/readOnlyProbes.js — one definition, shared, so the two
// cannot drift) against the LIVE reader connection.
//
// ── WHY IT IS SAFE TO POINT AT THE LIVE MART ────────────────────────────────
// Every probe is a statement the role must be REFUSED, wrapped in a transaction
// that is rolled back whatever happens. If the boundary holds, nothing is
// attempted successfully; if it does not, the test fails AND the change is
// rolled back. Building a throwaway database would not help either, because
// PostgreSQL roles are cluster-global: a test that created its own
// `metabase_reader` would be re-passwording the real one.
//
// Skipped, visibly, when no reader connection is configured.
"use strict";

require("dotenv").config();

const { Client } = require("pg");
const probes = require("../../services/reporting/readOnlyProbes");

const URL = process.env.REPORTING_READONLY_URL;

// This suite talks to PostgreSQL only. Spinning up mongodb-memory-server for it
// would add ~15s and a start-up timeout risk for no coverage at all.
process.env.TEST_WITHOUT_MONGO = "1";

const describeOrSkip = URL ? describe : describe.skip;

if (!URL) {
  test("read-only role tests are SKIPPED — REPORTING_READONLY_URL is not set", () => {
    expect(URL).toBeUndefined();
  });
}

describeOrSkip("the Metabase reader role", () => {
  let client;

  beforeAll(async () => {
    client = new Client({ connectionString: URL, connectionTimeoutMillis: 10_000 });
    await client.connect();
  }, 30_000);

  afterAll(async () => {
    if (client) await client.end();
  });

  test("it connects as metabase_reader, and not as the owner", async () => {
    const { rows } = await client.query("SELECT current_user u, session_user s");
    expect(rows[0].u).toBe("metabase_reader");
    expect(rows[0].s).toBe("metabase_reader");
  });

  test("it is not a superuser and cannot create databases or roles", async () => {
    const { rows } = await client.query(
      "SELECT rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = current_user",
    );
    expect(rows[0]).toMatchObject({
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
    });
  });

  test("it CAN read every approved object — the control", async () => {
    for (const probe of probes.MUST_ALLOW) {
      const r = await probes.probeAllowed(client, probe);
      expect({ label: r.label, ok: r.ok, outcome: r.outcome }).toMatchObject({ ok: true });
    }
  });

  test.each(probes.MUST_REFUSE.map((p) => [p.label, p]))(
    "it CANNOT: %s",
    async (_label, probe) => {
      const r = await probes.probeRefusal(client, probe);
      // The outcome is in the assertion so a failure says WHY, not just false.
      expect([r.label, r.ok, r.outcome]).toEqual([r.label, true, r.outcome]);
      expect(r.ok).toBe(true);
    },
  );

  test("it cannot grant itself a write privilege", async () => {
    const r = await probes.probeSelfGrant(client);
    expect(r.ok).toBe(true);
    expect(r.outcome).not.toMatch(/hole/);
  });

  test("it cannot open a session on any other database in the cluster", async () => {
    /* The maintenance database `postgres` ships with no ACL, so PUBLIC may
       connect unless that is explicitly revoked. This check is the reason the
       revoke is in R__roles.sql. */
    const { rows: dbs } = await client.query(
      "SELECT datname FROM pg_database WHERE datname NOT IN ('template0','template1')",
    );
    const current = (await client.query("SELECT current_database() d")).rows[0].d;
    const reachable = [];
    for (const { datname } of dbs) {
      if (datname === current) continue;
      const probe = new Client({
        connectionString: URL.replace(/\/[^/?]+(\?|$)/, `/${datname}$1`),
        connectionTimeoutMillis: 5000,
      });
      try {
        await probe.connect();
        await probe.end();
        reachable.push(datname);
      } catch {
        /* refused — the point */
      }
    }
    expect(reachable).toEqual([]);
  }, 30_000);

  test("every write verb is absent from the privilege catalogue too", async () => {
    // The probes prove behaviour; this proves the grants agree with it, so a
    // privilege that exists but happens to be unreachable still shows up.
    const { rows } = await client.query(
      `SELECT table_name, privilege_type
         FROM information_schema.table_privileges
        WHERE grantee = 'metabase_reader'
          AND privilege_type <> 'SELECT'`,
    );
    expect(rows).toEqual([]);
  });
});
