"use strict";
/**
 * services/gstPortal.test.js
 *
 * `fetch` is replaced throughout. Nothing here touches a provider, which is
 * the point: these are billed calls, and a test suite that made them would be
 * a test suite nobody could afford to run in a loop.
 *
 * What is pinned is the behaviour that only shows up on a bad day — a
 * provider that is slow, rate-limiting, unauthorised, or answering 200 with a
 * body that says the lookup failed. A compliance form must be able to tell
 * "this GSTIN does not exist" from "the provider is having an afternoon",
 * because those call for completely different actions.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const gstPortal = require("./gstPortal.service");
const { comparePortal, normaliseCompanyName } = require("./taxIdentity.service");

const GSTIN = "21AAMCG0739M1ZH";
const realFetch = global.fetch;

function configure(env = {}) {
  process.env.GST_PORTAL_PROVIDER = env.provider ?? "surepass";
  process.env.GST_PORTAL_API_KEY = env.key ?? "test-key";
  gstPortal._cache.clear();
}
function unconfigure() {
  delete process.env.GST_PORTAL_PROVIDER;
  delete process.env.GST_PORTAL_API_KEY;
  delete process.env.GSTIN_LOOKUP_API_URL;
  delete process.env.GSTIN_LOOKUP_API_KEY;
  gstPortal._cache.clear();
}

/** Replace fetch with something that answers once, however we like. */
function answering(fn) {
  global.fetch = fn;
}
test.afterEach?.(() => {
  global.fetch = realFetch;
});

const ok = (payload) => async () => ({
  ok: true,
  status: 200,
  json: async () => payload,
});

/* GSTN's own terse field names, as the raw providers pass them through. */
const GSTN_BODY = {
  data: {
    lgnm: "GRAV CLOTHING PRIVATE LIMITED",
    tradeNam: "GRAV CLOTHING",
    sts: "Active",
    rgdt: "01/04/2025",
    ctb: "Private Limited Company",
    stcd: "21",
    pradr: { adr: { bno: "8B", st: "MAYFAIR LAGOON CAMPUS", loc: "JAYDEV VIHAR", city: "BHUBANESWAR", stcd: "Odisha", pncd: "751013" } },
  },
};

/* ── configuration ─────────────────────────────────────────────────────── */

test("with no provider configured it refuses honestly and says how to fix it", async () => {
  unconfigure();
  const r = await gstPortal.lookupGstin(GSTIN);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "not-configured");
  /* Names the variables and says out loud that these are paid — the two
     things somebody needs and neither of which they can guess. */
  assert.match(r.hint, /GST_PORTAL_PROVIDER/);
  assert.match(r.hint, /paid/i);
});

test("the legacy GSTIN_LOOKUP_* variables still select a provider", async () => {
  unconfigure();
  process.env.GSTIN_LOOKUP_API_URL = "https://example.invalid/gst?gstin={GSTIN}";
  process.env.GSTIN_LOOKUP_API_KEY = "old-key";
  /* An install configured before this service existed must keep working
     without anybody editing .env. */
  assert.equal(gstPortal.isConfigured(), true);
  unconfigure();
});

/* ── reading whatever the provider sends ───────────────────────────────── */

test("GSTN's terse field names are normalised into ours", async () => {
  configure();
  answering(ok(GSTN_BODY));

  const r = await gstPortal.lookupGstin(GSTIN);
  assert.equal(r.ok, true);
  assert.equal(r.found, true);
  assert.equal(r.data.legalName, "GRAV CLOTHING PRIVATE LIMITED");
  assert.equal(r.data.status, "Active");
  assert.equal(r.data.stateCode, "21");
  /* The nested address object flattened to something printable. */
  assert.match(r.data.address, /BHUBANESWAR/);
  assert.match(r.data.address, /751013/);
  unconfigure();
});

test("a provider that renames every field is read just as well", async () => {
  configure();
  answering(ok({ result: { legal_name: "GRAV CLOTHING PRIVATE LIMITED", gstin_status: "Active" } }));

  const r = await gstPortal.lookupGstin(GSTIN);
  assert.equal(r.data.legalName, "GRAV CLOTHING PRIVATE LIMITED");
  assert.equal(r.data.status, "Active");
  unconfigure();
});

test("a 200 whose body says it failed is a miss, not a success", async () => {
  configure();
  /* Several providers answer 200 with { success: false }. Trusting the HTTP
     status would turn a missing registration into a successful lookup of
     nothing at all. */
  answering(ok({ success: false, message: "GSTIN not found" }));

  const r = await gstPortal.lookupGstin(GSTIN);
  assert.equal(r.ok, true);
  assert.equal(r.found, false);
  unconfigure();
});

test("an empty payload is a miss rather than a record with no fields", async () => {
  configure();
  answering(ok({ data: {} }));
  const r = await gstPortal.lookupGstin(GSTIN);
  assert.equal(r.found, false);
  unconfigure();
});

/* ── the bad afternoon ─────────────────────────────────────────────────── */

test("a 404 is an answer ABOUT the GSTIN; other errors are not", async () => {
  configure();

  answering(async () => ({ ok: false, status: 404 }));
  const missing = await gstPortal.lookupGstin(GSTIN);
  assert.equal(missing.ok, true);
  assert.equal(missing.found, false);

  gstPortal._cache.clear();
  answering(async () => ({ ok: false, status: 500 }));
  const broken = await gstPortal.lookupGstin(GSTIN);
  /* Crucially NOT `found: false` — the provider failed, and reporting that as
     "this registration does not exist" would be a false accusation against a
     real company. */
  assert.equal(broken.ok, false);
  assert.equal(broken.reason, "provider-error");
  assert.equal(broken.found, undefined);
  unconfigure();
});

test("a bad key and a rate limit are told apart", async () => {
  configure();

  answering(async () => ({ ok: false, status: 401 }));
  assert.equal((await gstPortal.lookupGstin(GSTIN)).reason, "auth");

  gstPortal._cache.clear();
  answering(async () => ({ ok: false, status: 429 }));
  assert.equal((await gstPortal.lookupGstin(GSTIN)).reason, "rate-limited");
  unconfigure();
});

test("a provider that never answers is abandoned, not waited on", async () => {
  configure();
  process.env.GST_PORTAL_TIMEOUT_MS = "50";
  /* Honours the abort signal the way a real fetch does. */
  answering(
    (url, opts) =>
      new Promise((_resolve, reject) => {
        opts.signal.addEventListener("abort", () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        });
      }),
  );

  const started = Date.now();
  const r = await gstPortal.lookupGstin(GSTIN);
  /* The form must not hang because a third party is slow. */
  assert.equal(r.ok, false);
  assert.equal(r.reason, "timeout");
  assert.ok(Date.now() - started < 2000);
  delete process.env.GST_PORTAL_TIMEOUT_MS;
  unconfigure();
});

test("a thrown network error is caught, never propagated", async () => {
  configure();
  answering(async () => {
    throw new Error("ECONNREFUSED");
  });
  const r = await gstPortal.lookupGstin(GSTIN);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "network");
  unconfigure();
});

/* ── the cache, which is what makes this affordable ────────────────────── */

test("a repeat lookup does not bill the company twice", async () => {
  configure();
  let calls = 0;
  answering(async () => {
    calls++;
    return { ok: true, status: 200, json: async () => GSTN_BODY };
  });

  await gstPortal.lookupGstin(GSTIN);
  const second = await gstPortal.lookupGstin(GSTIN);

  assert.equal(calls, 1);
  assert.equal(second.cached, true);
  assert.equal(second.data.legalName, "GRAV CLOTHING PRIVATE LIMITED");

  /* And an explicit re-check still reaches the provider — somebody who has
     just fixed a registration needs to be able to ask again. */
  await gstPortal.lookupGstin(GSTIN, { force: true });
  assert.equal(calls, 2);
  unconfigure();
});

test("a failed lookup is NOT cached", async () => {
  configure();
  let calls = 0;
  answering(async () => {
    calls++;
    return { ok: false, status: 500 };
  });
  await gstPortal.lookupGstin(GSTIN);
  await gstPortal.lookupGstin(GSTIN);
  /* Caching an outage would keep answering with it long after it ended. */
  assert.equal(calls, 2);
  unconfigure();
});

/* ── comparing the register against the form ───────────────────────────── */

test("the same company written two ways is not a mismatch", () => {
  for (const [typed, registered] of [
    ["GRAV CLOTHING PVT LTD", "GRAV CLOTHING PRIVATE LIMITED"],
    ["A & B Inds Ltd", "A AND B INDUSTRIES LIMITED"],
    ["GRAV CLOTHING PVT LTD", "GRAV CLOTHING (OPC) PRIVATE LIMITED"],
  ]) {
    const findings = comparePortal(
      { companyName: typed, gstin: GSTIN },
      { ok: true, found: true, data: { legalName: registered, status: "Active" } },
    );
    assert.equal(
      findings.length,
      0,
      `"${typed}" vs "${registered}" should not be reported: ${JSON.stringify(findings)}`,
    );
  }
});

test("a genuinely different registered name is reported, with the fix offered", () => {
  const findings = comparePortal(
    { companyName: "GRAV CLOTHING PVT LTD", gstin: GSTIN },
    { ok: true, found: true, data: { legalName: "ZENITH TEXTILES PRIVATE LIMITED", status: "Active" } },
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "warn");
  assert.equal(findings[0].source, "portal");
  assert.equal(findings[0].suggestion.companyName, "ZENITH TEXTILES PRIVATE LIMITED");
});

test("a cancelled registration is an ERROR — this is what offline can never know", () => {
  const findings = comparePortal(
    { companyName: "GRAV CLOTHING PVT LTD", gstin: GSTIN },
    {
      ok: true,
      found: true,
      data: { legalName: "GRAV CLOTHING PRIVATE LIMITED", status: "Cancelled", cancelledDate: "31/03/2026" },
    },
  );
  const hit = findings.find((f) => f.severity === "error");
  assert.ok(hit);
  /* A cancelled GSTIN stays well-formed forever — the check digit will pass
     on it until the end of time. Only the register knows. */
  assert.match(hit.message, /Cancelled/);
  assert.match(hit.message, /31\/03\/2026/);
  assert.match(hit.message, /do not raise invoices/i);
});

test("a GSTIN with no registration behind it is an error the check digit cannot give you", () => {
  const findings = comparePortal(
    { companyName: "GRAV CLOTHING PVT LTD", gstin: GSTIN },
    { ok: true, found: false },
  );
  assert.equal(findings[0].severity, "error");
  assert.match(findings[0].message, /no registration/i);
});

test("a failed lookup produces no findings at all", () => {
  /* Silence, not a verdict. A provider outage must never read as a fact
     about the company. */
  for (const lookup of [
    { ok: false, reason: "timeout" },
    { ok: false, reason: "not-configured" },
    null,
  ]) {
    assert.deepEqual(comparePortal({ companyName: "X", gstin: GSTIN }, lookup), []);
  }
});

test("normalising a name keeps what identifies the company", () => {
  assert.equal(normaliseCompanyName("GRAV CLOTHING PVT. LTD."), "GRAV CLOTHING PRIVATE LIMITED");
  assert.equal(normaliseCompanyName("  a & b   co  "), "A AND B COMPANY");
});


/* ═══════════════════════════════════════════════════════════════════════════
 * ANSWERING ABOUT THE RIGHT COMPANY
 *
 * Found live, not imagined: Appyflow's free credits are a sandbox that
 * returns ONE fixed demo record for every GSTIN you send — HTTP 200,
 * `error: false`, indistinguishable from a real verification. Two lookups for
 * two unrelated GSTINs in different states came back byte-identical.
 *
 * The damage that would have done is worth stating: every company would have
 * "verified" as a proprietorship in Ludhiana, the name comparison would have
 * flagged a mismatch against every real record, and the Use-it button beside
 * that finding would have offered to rename the company master to the demo
 * company's name.
 * ══════════════════════════════════════════════════════════════════════════ */

test("a response about a different GSTIN is refused, not reported", async () => {
  configure();
  answering(
    ok({
      taxpayerInfo: {
        gstin: "03DOXPM4071K1ZE",
        lgnm: "DISHANT MAHAJAN",
        tradeNam: "AppyFlow Technologies",
        sts: "Active",
      },
      error: false,
      message: "Kindly use paid credits for GST verification in production. Free credits are meant only for testing in sandbox.",
    }),
  );

  const r = await gstPortal.lookupGstin(GSTIN);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "mismatched-response");
  assert.equal(r.asked, GSTIN);
  assert.equal(r.answered, "03DOXPM4071K1ZE");
  /* The provider says so in words when it is a sandbox; surfaced so the
     operator is told to buy credits rather than left guessing. */
  assert.equal(r.sandbox, true);
  unconfigure();
});

test("a sandbox answer is not cached, and produces no findings", async () => {
  configure();
  let calls = 0;
  answering(async () => {
    calls++;
    return {
      ok: true,
      status: 200,
      json: async () => ({ taxpayerInfo: { gstin: "03DOXPM4071K1ZE", lgnm: "DEMO", sts: "Active" } }),
    };
  });

  await gstPortal.lookupGstin(GSTIN);
  await gstPortal.lookupGstin(GSTIN);
  /* Caching a wrong answer would keep serving it for a day after the account
     is upgraded. */
  assert.equal(calls, 2);

  /* And nothing about it may reach the form as a verdict. */
  assert.deepEqual(
    comparePortal({ companyName: "GRAV CLOTHING PVT LTD", gstin: GSTIN }, { ok: false, reason: "mismatched-response" }),
    [],
  );
  unconfigure();
});

test("an echo that matches is accepted, and fills in the state code", async () => {
  configure();
  answering(ok({ taxpayerInfo: { gstin: GSTIN, lgnm: "GRAV CLOTHING PRIVATE LIMITED", sts: "Active" } }));

  const r = await gstPortal.lookupGstin(GSTIN);
  assert.equal(r.ok, true);
  assert.equal(r.found, true);
  /* Appyflow omits the top-level state code; the echoed GSTIN carries it in
     its first two digits, which is the authoritative place anyway. */
  assert.equal(r.data.stateCode, "21");
  unconfigure();
});

test("a provider that echoes nothing is still trusted", async () => {
  configure();
  /* Not every provider echoes. The guard must catch a WRONG answer without
     rejecting a provider that simply says less. */
  answering(ok({ data: { legal_name: "GRAV CLOTHING PRIVATE LIMITED", status: "Active" } }));
  const r = await gstPortal.lookupGstin(GSTIN);
  assert.equal(r.ok, true);
  assert.equal(r.found, true);
  unconfigure();
});
