// test/marketing/provider-invisibility.test.js
//
// THE MARKETING ENGINE MUST NOT BE VISIBLE TO AN ORDINARY GRAV USER.
//
// GRAV's marketing automation runs on Mautic. That is documented honestly in the
// architecture decision record and in the header of every file that talks to it,
// because a developer needs to know. A marketer reading a screen does not, and a
// browser response that says so has three separate problems: it teaches a client
// to special-case a product GRAV may replace, it tells a reader where the
// marketing platform lives, and it hands an attacker a version and a route map.
//
// ── WHY THIS SUITE SCANS RATHER THAN ASSERTS ───────────────────────────────
// A boundary maintained by good intentions lasts until the next hurried fix.
// These tests drive every Marketing route, in every failure mode they can be put
// into, and then SEARCH the whole serialised response for the provider's name,
// its URLs, its API paths, its error vocabulary and its credential variables. A
// message written next year without reading `providerPrivacy.js` fails here.
"use strict";

const express = require("express");
const mongoose = require("mongoose");

jest.mock("../../Middlewear/MarketingAuthMiddlewear", () => {
  const mw = (req, res, next) => {
    const raw = req.headers["x-test-user"];
    if (!raw) return res.status(401).json({ success: false, message: "Authentication required." });
    const user = JSON.parse(raw);
    if (!["marketing", "admin", "ceo"].includes(user.role) && !user.isAdmin) {
      return res.status(403).json({ success: false, message: "Access denied." });
    }
    req.user = user;
    next();
  };
  mw.withRoles = () => mw;
  mw.ALLOWED_ROLES = ["marketing", "admin", "ceo"];
  return mw;
});
jest.mock("../../services/changeLog", () => ({
  recordChange: jest.fn().mockResolvedValue(undefined),
  historyForWithChildren: jest.fn(),
}));

const providerPrivacy = require("../../services/marketing/providerPrivacy");
const contentInventory = require("../../services/marketing/contentInventory.service");
const { fail } = require("../../services/storePurchase/errors");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const Handover = require("../../models/CMS_Models/Marketing/ProspectHandover");
const { MarketingTrackingConfig } = require("../../models/CMS_Models/Marketing/MarketingTrackingConfig");
const MarketingIdentity = require("../../models/CMS_Models/Marketing/MarketingIdentity");
const MarketingDeliveryState = require("../../models/CMS_Models/Marketing/MarketingDeliveryState");
const consentService = require("../../services/marketing/marketingConsent.service");

const ADMIN = { id: new mongoose.Types.ObjectId().toString(), name: "Ada", role: "admin", email: "ada@grav.in" };

/* ── WHAT MAY NEVER APPEAR IN A BROWSER RESPONSE ────────────────────────────
   Each entry is a thing a reader could use to identify, locate or exploit the
   engine. `id` and similar innocuous words are deliberately absent: this list is
   about the provider, not about being coy. */
const FORBIDDEN = Object.freeze([
  [/mautic/i, "the provider's name"],
  /* Not "any URL": the tracking configuration legitimately carries the
     customer's own public website, which is theirs and which they typed. What
     must never appear is an address that locates GRAV's own infrastructure. */
  [/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|[^\s"']*mautic[^\s"']*|10\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.)/i, "an internal or provider URL"],
  [/\/api\/(emails|forms|pages|contacts|segments|campaigns|hooks|users|roles)/i, "a provider API path"],
  [/\/oauth\/v2\/token/i, "the provider token endpoint"],
  [/MAUTIC_[A-Z_]+/, "a provider configuration variable"],
  [/GATEWAY_[A-Z_]+/, "a gateway credential variable"],
  [/grav-(integration|content-reader)\b/i, "a provider account name"],
  [/\bBasic [A-Za-z0-9+/=]{8,}/, "an encoded credential"],
  [/\bBearer [A-Za-z0-9._-]{8,}/, "a bearer token"],
  [/localhost:\d+|127\.0\.0\.1:\d+/, "an internal address"],
  [/7\.2\.0|apache\/2|php\/8/i, "provider version information"],
  /* The provider's own error vocabulary. A client that learns these codes is a
     client coupled to the provider. */
  [/MAUTIC_UNAVAILABLE|MAUTIC_AUTH_FAILED|MAUTIC_REJECTED_WRITE|MAUTIC_MALFORMED_RESPONSE|MAUTIC_NOT_CONFIGURED|MAUTIC_BAD_REQUEST/, "a provider error code"],
]);

/** Assert one serialised response carries nothing from that list. */
function assertNoProviderTrace(label, payload) {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  for (const [pattern, what] of FORBIDDEN) {
    if (pattern.test(text)) {
      throw new Error(`${label} leaked ${what}: ${text.slice(0, 400)}`);
    }
  }
}

let A;
let server;
let base;
const savedEnv = {};
const ENV_KEYS = [
  "MARKETING_COMPANY_ID", "MAUTIC_BASE_URL", "MAUTIC_AUTH_MODE",
  "MAUTIC_BASIC_USERNAME", "MAUTIC_BASIC_PASSWORD",
  "MAUTIC_CONTENT_BASIC_USERNAME", "MAUTIC_CONTENT_BASIC_PASSWORD",
];

beforeAll(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  const app = express();
  app.use((req, _res, next) => {
    const c = String(req.headers["x-test-company"] || "");
    if (mongoose.Types.ObjectId.isValid(c)) req.__marketingCompanyId = new mongoose.Types.ObjectId(c);
    next();
  });
  for (const r of ["contentInventory", "marketingHandovers", "dataHealth", "trackingIntegrations"]) {
    app.use("/api/cms/marketing", require(`../../routes/CMS_Routes/Marketing/${r}`));
  }
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/marketing`;
});
afterAll(async () => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await new Promise((r) => server.close(r));
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

beforeEach(async () => {
  const c = await Acc_Company.create({ companyName: "GRAV Privacy", booksFromDate: new Date("2026-04-01") });
  A = c._id;
  process.env.MARKETING_COMPANY_ID = String(A);
  /* A configured-looking engine, so routes get past their configuration check
     and reach the paths where a provider name could escape. Deliberately
     pointing at a closed port: every provider call fails, which is exactly the
     state that produces provider-shaped errors. */
  process.env.MAUTIC_BASE_URL = "http://127.0.0.1:9";
  process.env.MAUTIC_AUTH_MODE = "basic";
  process.env.MAUTIC_BASIC_USERNAME = "grav-integration";
  process.env.MAUTIC_BASIC_PASSWORD = "not-a-real-password";
  process.env.MAUTIC_CONTENT_BASIC_USERNAME = "grav-content-reader";
  process.env.MAUTIC_CONTENT_BASIC_PASSWORD = "also-not-real";
});

const call = async (path, { user = ADMIN, method = "GET", body, company = null } = {}) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "x-test-user": JSON.stringify(user),
      "x-test-company": String(company || A),
      "Content-Type": "application/json",
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, text: await res.text() };
};

/* ═══════════════════════════════════════════════════════════════════════════
   1. EVERY MARKETING ROUTE, IN EVERY STATE IT CAN BE PUT INTO
   ═══════════════════════════════════════════════════════════════════════════ */

describe("no Marketing response mentions the engine", () => {
  /* Including the failure paths, which is where a provider name usually
     escapes: the happy path was written carefully and the error path was
     written at the end of the day. */
  const ROUTES = [
    ["content list", "/content?kind=email"],
    ["content list, form", "/content?kind=form"],
    ["content list, landing page", "/content?kind=landing_page"],
    ["content list, bad kind", "/content?kind=newsletter"],
    ["content list, no kind", "/content"],
    ["content list, bad limit", "/content?kind=email&limit=0"],
    ["content list, bad cursor", "/content?kind=email&cursor=nope"],
    ["content summary", "/content/summary"],
    ["engine health", "/health"],
    ["data health", "/data-health"],
    ["data health records", "/data-health/records"],
    ["data health engagement", "/data-health/engagement"],
    ["data health person", "/data-health/person/unknown-key"],
    ["handover list", "/handovers"],
    ["handover detail", "/handovers/MHO-2026-0001"],
    ["tracking config", "/integrations/tracking"],
    ["tracking history", "/integrations/tracking/history"],
  ];

  test.each(ROUTES)("%s carries no provider trace", async (label, path) => {
    const res = await call(path);
    assertNoProviderTrace(`${label} (${res.status})`, res.text);
  });

  test("a tracking save refusal carries no provider trace", async () => {
    for (const body of [
      { siteUrl: "https://a.example", trackingMode: "gtm", gtmContainerId: "bad", expectedRevision: 0 },
      { metaAccessToken: "x", expectedRevision: 0 },
      { expectedRevision: "one" },
    ]) {
      const res = await call("/integrations/tracking", { method: "PUT", body });
      assertNoProviderTrace(`tracking save (${res.status})`, res.text);
    }
  });

  test("the acquisition-hold retry seam carries no provider trace", async () => {
    const res = await call("/handovers/acquisition-holds/retry", { method: "POST", body: {} });
    assertNoProviderTrace(`retry seam (${res.status})`, res.text);
  });

  test("a handover detail with a failed engine hold carries no provider trace", async () => {
    /* A real handover, so the route reaches its acquisition presentation rather
       than stopping at a 404. */
    await Handover.create({
      companyId: A, handoverRef: "MHO-2026-7001", state: "ACCEPTED",
      company: { name: "Aurora" }, person: { workEmail: "a@aurora.example" },
      assessment: { handoverReason: "Asked.", recommendedAction: "email_introduction" },
      correlationId: "corr-7001", submittedAt: new Date(),
      outcome: { decision: "ACCEPTED", decidedAt: new Date() },
    });
    const res = await call("/handovers/MHO-2026-7001");
    assertNoProviderTrace(`handover detail (${res.status})`, res.text);
  });

  test("a saved tracking configuration carries no provider trace", async () => {
    await MarketingTrackingConfig.create({
      companyId: A, siteUrl: "https://shop.example", trackingMode: "gtm",
      gtmContainerId: "GTM-ABC1234", enabled: true, revision: 1,
      verification: { state: "saved_unverified", safeMessage: "Saved." },
    });
    const res = await call("/integrations/tracking");
    assertNoProviderTrace(`tracking read (${res.status})`, res.text);
  });

  test("an unconfigured engine still answers without naming it", async () => {
    delete process.env.MAUTIC_BASE_URL;
    for (const path of ["/content?kind=email", "/content/summary", "/health"]) {
      const res = await call(path);
      assertNoProviderTrace(`unconfigured ${path} (${res.status})`, res.text);
    }
  });

  /* ── AN EMPTY COLLECTION MAKES A SCANNING TEST PASS FOR THE WRONG REASON ──
     Every route above was already swept, and two leaks still shipped: the data
     health backlog served a row keyed `mauticContactId` carrying the internal
     reason code, and nothing caught it because the collection was empty and the
     `records` array serialised as `[]`. A scan over no rows scans nothing. So
     this seeds the failure the backlog exists to report and scans the rows
     themselves — including their KEY NAMES, which is where that leak lived. */
  test("the failure backlog names no provider, in its values or its keys", async () => {
    await MarketingIdentity.create({
      companyId: A, gravPersonKey: "grav-person-privacy-1", email: "ops@aurora.example",
      externals: [{ system: "mautic", externalId: "8821", proven: true }],
    });
    /* Consent, or the backlog classifies the row CONSENT_MISSING and never
       reaches the provider-derived reason this test is about. */
    await consentService.record({
      companyId: A, gravPersonKey: "grav-person-privacy-1",
      ...consentService.MARKETING_EMAIL, state: "opted_in",
      capturedSource: "test: landing page form", noticeVersion: "v3",
      actor: { kind: "user", id: new mongoose.Types.ObjectId(), name: "Ada", email: "ada@grav.in" },
    });
    await MarketingDeliveryState.create({
      companyId: A, gravPersonKey: "grav-person-privacy-1",
      health: "RETRY_SCHEDULED", attempts: 3, retryCount: 2,
      lastAttemptAt: new Date(), nextAttemptAt: new Date(Date.now() + 60_000),
      mauticContactId: "8821",
      activeError: {
        reasonCode: "MAUTIC_UNREACHABLE", sourceCode: "MAUTIC_UNAVAILABLE",
        failureClass: "TRANSIENT", at: new Date(), attemptNo: 3,
        message: "Mautic did not respond. This is not an empty result — nothing could be checked.",
      },
    });

    for (const path of ["/data-health", "/data-health/records", "/data-health/person/grav-person-privacy-1"]) {
      const res = await call(path);
      expect(res.status).toBe(200);
      assertNoProviderTrace(`seeded ${path} (${res.status})`, res.text);
    }

    /* And the row really was there — otherwise this test would pass on an empty
       backlog exactly the way the sweep above did. */
    const records = JSON.parse((await call("/data-health/records")).text);
    expect(records.records).toHaveLength(1);
    expect(records.records[0].reasonCode).toBe("MARKETING_ENGINE_UNREACHABLE");
    expect(records.records[0]).toHaveProperty("engineContactRef", "8821");
  });

  test("a company with no marketing library is refused without naming the engine", async () => {
    const res = await call("/content?kind=email", { company: new mongoose.Types.ObjectId() });
    expect(res.status).toBe(403);
    assertNoProviderTrace("cross-company refusal", res.text);
    expect(JSON.parse(res.text).error.code).toBe("MARKETING_COMPANY_NOT_CONFIGURED");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   2. THE TRANSLATION ITSELF
   ═══════════════════════════════════════════════════════════════════════════ */

describe("provider failures become GRAV-owned answers", () => {
  test.each([
    ["MAUTIC_UNAVAILABLE", "MARKETING_ENGINE_UNAVAILABLE", 503],
    ["MAUTIC_AUTH_FAILED", "MARKETING_ENGINE_UNAVAILABLE", 503],
    ["MAUTIC_MALFORMED_RESPONSE", "MARKETING_ENGINE_UNAVAILABLE", 503],
    ["MAUTIC_NOT_CONFIGURED", "MARKETING_ENGINE_NOT_CONFIGURED", 409],
    ["MAUTIC_REJECTED_WRITE", "MARKETING_ENGINE_REJECTED_REQUEST", 422],
    ["MAUTIC_BAD_REQUEST", "MARKETING_ENGINE_REJECTED_REQUEST", 422],
  ])("%s becomes %s (%i)", (internal, expected, status) => {
    const face = providerPrivacy.publicFace(fail(internal,
      "Mautic refused GRAV's credentials at http://mautic.internal/api/emails",
      { url: "/api/emails", status: 403, attempts: 3 }));
    expect(face.code).toBe(expected);
    expect(face.status).toBe(status);
    assertNoProviderTrace(`${internal} translation`, face);
    /* The provider's own sentence is never the source of the public one. */
    expect(face.message).toBe(providerPrivacy.PUBLIC_MESSAGE[expected]);
  });

  test("the three operational failures collapse to one public answer", () => {
    /* Unreachable, refused and unparseable are one thing to a marketer: the
       engine is not answering. The distinction survives in the log. */
    const codes = ["MAUTIC_UNAVAILABLE", "MAUTIC_AUTH_FAILED", "MAUTIC_MALFORMED_RESPONSE"]
      .map((c) => providerPrivacy.publicFace(fail(c, "x")).code);
    expect(new Set(codes).size).toBe(1);
  });

  test("a GRAV refusal keeps its own code and actionable details", () => {
    const face = providerPrivacy.publicFace(fail("VALIDATION",
      "limit must be a whole number between 1 and 50.",
      { field: "limit", min: 1, max: 50, status: 400, url: "/api/emails" }));
    expect(face.code).toBe("VALIDATION");
    expect(face.message).toMatch(/whole number/);
    /* Request-shaped details survive; provider-shaped ones are dropped. */
    expect(face.details).toEqual({ field: "limit", min: 1, max: 50 });
  });

  test("the scrubber catches a provider name somebody let slip", () => {
    const messy = "Mautic's API at https://mautic.internal:8088/api/contacts refused MAUTIC_BASIC_PASSWORD for grav-integration with Basic YWJjZGVmZ2hpamtsbW5vcA==";
    const clean = providerPrivacy.scrubText(messy);
    assertNoProviderTrace("scrubbed text", clean);
    expect(clean).toContain("marketing engine");
  });

  test("provider-shaped detail keys are dropped rather than scrubbed", () => {
    /* A scrubbed status code is still a status code. */
    const details = providerPrivacy.sanitiseDetails({
      url: "/api/emails", status: 503, attempts: 4, cause: "ECONNREFUSED",
      hostname: "mautic.internal", field: "limit", accepted: ["email", "form"],
    });
    expect(Object.keys(details).sort()).toEqual(["accepted", "field"]);
  });

  test("an unknown internal error does not leak its message verbatim", () => {
    const face = providerPrivacy.publicFace(
      Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8088 while calling Mautic"), {}),
    );
    assertNoProviderTrace("unknown error", face);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   3. THE SERVER LOG KEEPS THE TRUTH, WITHOUT THE SECRETS
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the honest detail goes to the log, and secrets do not", () => {
  test("a provider failure is logged with its real code and path", () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    providerPrivacy.logProviderFailure(
      fail("MAUTIC_UNAVAILABLE", "Mautic did not respond.", { url: "/api/emails", status: 503 }),
      { operation: "GET /content", kind: "email" },
    );
    const line = spy.mock.calls[0].join(" ");
    spy.mockRestore();
    /* A technical operator needs to know WHICH system failed, so the log names
       it — this is the one place that may. */
    expect(line).toContain("MAUTIC_UNAVAILABLE");
    expect(line).toContain("/api/emails");
    expect(line).toContain("kind=email");
  });

  test("a credential is redacted even in the log", () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    providerPrivacy.logProviderFailure(
      fail("MAUTIC_AUTH_FAILED",
        "refused Basic YWJjZGVmZ2hpamtsbW5vcA== and Bearer abcdefghijklmnop and password=hunter2"),
      { operation: "GET /content" },
    );
    const line = spy.mock.calls[0].join(" ");
    spy.mockRestore();
    expect(line).not.toContain("YWJjZGVmZ2hpamtsbW5vcA==");
    expect(line).not.toContain("abcdefghijklmnop");
    expect(line).not.toContain("hunter2");
    expect(line).toContain("[redacted]");
  });

  test("a provider failure reaching a route is logged once and answered safely", async () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    const res = await call("/content?kind=email");
    const logged = spy.mock.calls.map((c) => c.join(" ")).join("\n");
    spy.mockRestore();
    assertNoProviderTrace("content list over a dead engine", res.text);
    /* Named in the log, absent from the response. */
    expect(logged).toMatch(/marketing:provider/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   4. THE GRAV VOCABULARY
   ═══════════════════════════════════════════════════════════════════════════ */

describe("GRAV terminology is what a reader sees", () => {
  test("the content vocabulary names GRAV content types and the engine's role", () => {
    const v = contentInventory.vocabulary;
    expect(v.kinds.map((k) => k.code)).toEqual(["email", "form", "landing_page"]);
    /* The served labels are GRAV content types. `pair()` names the label field,
       so read whichever it uses rather than assuming. */
    const labels = v.kinds.map((k) => k.means ?? k.label ?? k.description);
    expect(labels).toEqual(["Email", "Form", "Landing page"]);
    for (const value of Object.values(v.ownership)) assertNoProviderTrace("ownership", String(value));
    expect(v.ownership.sending).toBe("marketing_engine");
    expect(v.ownership.publishedMeans).toMatch(/marketing engine/);
    expect(v.ownership.publishedMeans).toMatch(/does not prove/);
  });

  test("the public failure sentences use the GRAV label", () => {
    for (const message of Object.values(providerPrivacy.PUBLIC_MESSAGE)) {
      expect(message).toMatch(/marketing engine/);
      assertNoProviderTrace("public message", message);
    }
  });

  test("a content identifier is opaque and GRAV-named", () => {
    const row = contentInventory.safeRow("email", { id: 42, name: "Spring" });
    expect(row.contentId).toBe("42");
    expect(row.id).toBeUndefined();
    /* Nothing in a row names the provider or its field names. */
    assertNoProviderTrace("content row", row);
  });

  test("no Marketing router imports the shared error sender directly", () => {
    /* The shared `sendError` would put the provider's code and message on the
       wire. Every Marketing router must use the privacy boundary's version. */
    const fs = require("fs");
    for (const r of ["contentInventory", "marketingHandovers", "dataHealth", "trackingIntegrations"]) {
      const src = fs.readFileSync(
        require.resolve(`../../routes/CMS_Routes/Marketing/${r}`), "utf8",
      );
      expect(src).toMatch(/providerPrivacy/);
      expect(src).not.toMatch(/\{[^}]*\bsendError\b[^}]*\}\s*=\s*require\([^)]*storePurchase\/errors/);
    }
  });
});
