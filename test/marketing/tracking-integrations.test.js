// test/marketing/tracking-integrations.test.js
//
// WEBSITE TRACKING CONFIGURATION: WHAT IT STORES, WHAT IT REFUSES, AND WHAT IT
// REFUSES TO CLAIM.
//
// Three kinds of mistake are possible in a settings slice like this, and every
// block below pins one:
//
//   1. Storing something it should not — a token, a snippet, a company chosen
//      by the caller.
//   2. Storing something incoherent — a container and a direct tag that would
//      both fire and double every number a decision later rests on.
//   3. Claiming something it does not know — that a pasted identifier is
//      installed, connected or verified.
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

const trackingConfig = require("../../services/marketing/trackingConfig.service");
const {
  MarketingTrackingConfig, MarketingTrackingConfigHistory, HISTORY_IMMUTABLE_MESSAGE,
} = require("../../models/CMS_Models/Marketing/MarketingTrackingConfig");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const { TRACKING_MODE_CODES } = require("../../constants/marketing");

const MARKETER = { id: new mongoose.Types.ObjectId().toString(), name: "Mira", role: "marketing", email: "mira@grav.in" };
const ADMIN = { id: new mongoose.Types.ObjectId().toString(), name: "Ada", role: "admin", email: "ada@grav.in" };
const CEO = { id: new mongoose.Types.ObjectId().toString(), name: "Cee", role: "ceo", email: "cee@grav.in" };

const SITE = "https://www.gravclothing.example";
const GTM = "GTM-ABC1234";
const GA4 = "G-ABCD1234";
const PIXEL = "123456789012345";

let A;
let B;
let server;
let base;
const savedEnv = {};
const ENV_KEYS = ["NODE_ENV", "MARKETING_TRACKING_ALLOW_LOCALHOST_HTTP"];

beforeAll(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  const app = express();
  /* ── THE COMPANY, PINNED THE WAY THE SESSION PINS IT ────────────────────
     In production `resolveCompanyForActor` reads the actor's membership. Here
     it comes from a header, set BEFORE the router under the same memo key the
     router itself uses. That leaves the payload tests meaningful: the company
     is fixed by something outside the body, and a caller naming one in the body
     must still be refused. */
  app.use((req, _res, next) => {
    /* Absent for the unauthenticated tests, which must reach the auth
       middleware and be refused there rather than failing here. */
    const header = String(req.headers["x-test-company"] || "");
    if (mongoose.Types.ObjectId.isValid(header)) {
      req.__marketingCompanyId = new mongoose.Types.ObjectId(header);
    }
    next();
  });
  app.use("/api/cms/marketing", require("../../routes/CMS_Routes/Marketing/trackingIntegrations"));
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

/* Jest reuses a worker across files, so anything left here would follow the
   next suite. */
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

beforeEach(async () => {
  const c = await Acc_Company.create({ companyName: "GRAV Tracking", booksFromDate: new Date("2026-04-01") });
  A = c._id;
  B = new mongoose.Types.ObjectId();
  await MarketingTrackingConfig.syncIndexes();
  await MarketingTrackingConfigHistory.syncIndexes();
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
  return { status: res.status, body: await res.json() };
};

const savePayload = (over = {}) => ({
  siteUrl: SITE, trackingMode: "gtm", gtmContainerId: GTM, enabled: true, expectedRevision: 0, ...over,
});

/* ═══════════════════════════════════════════════════════════════════════════
   1. WHAT IT REFUSES TO STORE
   ═══════════════════════════════════════════════════════════════════════════ */

describe("it stores no secret, no script and no caller-chosen company", () => {
  test.each([
    ["metaAccessToken", { metaAccessToken: "EAAG..." }],
    ["conversionsApiToken", { conversionsApiToken: "abc" }],
    ["capiToken", { capiToken: "abc" }],
    ["googleClientSecret", { googleClientSecret: "GOCSPX-..." }],
    ["clientSecret", { clientSecret: "x" }],
    ["refreshToken", { refreshToken: "1//0g..." }],
    ["access_token", { access_token: "x" }],
    ["ACCESS-TOKEN", { "ACCESS-TOKEN": "x" }],
    ["apiKey", { apiKey: "x" }],
    ["password", { password: "x" }],
  ])("a submitted %s is refused by name, not silently dropped", async (_label, extra) => {
    const res = await call("/integrations/tracking", {
      method: "PUT", body: savePayload(extra),
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION");
    /* Named, so the author knows GRAV did not take it and goes on looking for
       where it actually belongs. */
    expect(res.body.error.message).toContain(Object.keys(extra)[0]);
    expect(res.body.error.message).toMatch(/does not store provider secrets/i);
    expect(await MarketingTrackingConfig.countDocuments({})).toBe(0);
  });

  test.each([
    ["customScript", { customScript: "<script>alert(1)</script>" }],
    ["headSnippet", { headSnippet: "<script src=x></script>" }],
    ["customHtml", { customHtml: "<img onerror=alert(1)>" }],
    ["inlineJavascript", { inlineJavascript: "fetch('/steal')" }],
    ["tagCode", { tagCode: "console.log(1)" }],
  ])("arbitrary code in %s is refused", async (_label, extra) => {
    const res = await call("/integrations/tracking", { method: "PUT", body: savePayload(extra) });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain(Object.keys(extra)[0]);
    expect(await MarketingTrackingConfig.countDocuments({})).toBe(0);
  });

  test("script or HTML smuggled into an ID field fails the shape check", async () => {
    for (const bad of [
      "<script>alert(1)</script>",
      "GTM-ABC1234\"><script>x</script>",
      "javascript:alert(1)",
      "G-ABCD1234 onload=alert(1)",
    ]) {
      const res = await call("/integrations/tracking", {
        method: "PUT", body: savePayload({ gtmContainerId: bad }),
      });
      expect(res.status).toBe(400);
    }
    expect(await MarketingTrackingConfig.countDocuments({})).toBe(0);
  });

  test("an unknown field is refused rather than ignored", async () => {
    const res = await call("/integrations/tracking", {
      method: "PUT", body: savePayload({ hotjarId: "123", enabledd: true }),
    });
    expect(res.status).toBe(400);
    expect(res.body.error.details.unknown.sort()).toEqual(["enabledd", "hotjarId"]);
    /* A silently ignored typo means the setting somebody believed they changed
       did not change. */
    expect(res.body.error.details.accepted).toEqual(trackingConfig.ACCEPTED_FIELDS);
  });

  test("a company named in the payload is refused, and the session's company is used", async () => {
    const res = await call("/integrations/tracking", {
      method: "PUT", body: savePayload({ companyId: String(B) }),
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/taken from your session/i);
    expect(await MarketingTrackingConfig.countDocuments({ companyId: B })).toBe(0);
    expect(await MarketingTrackingConfig.countDocuments({ companyId: A })).toBe(0);
  });

  test("no stored document ever holds a secret-shaped field", async () => {
    await call("/integrations/tracking", { method: "PUT", body: savePayload() });
    const doc = await MarketingTrackingConfig.findOne({ companyId: A }).lean();
    const keys = new Set();
    (function walk(node) {
      if (!node || typeof node !== "object") return;
      for (const [k, v] of Object.entries(node)) { keys.add(k.toLowerCase()); walk(v); }
    }(doc));
    for (const forbidden of ["accesstoken", "clientsecret", "refreshtoken", "apikey", "script", "html"]) {
      expect([...keys].some((k) => k.includes(forbidden))).toBe(false);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   1b. DECLARED TYPES, WITH NO COERCION
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the JSON contract accepts only the declared types", () => {
  const stored = async () => MarketingTrackingConfig.findOne({ companyId: A }).lean();

  test.each([
    ["a string", "false"],
    ["a number", 1],
    ["zero", 0],
    ["null", null],
    ["an array", []],
    ["an object", {}],
  ])("enabled refuses %s", async (_label, value) => {
    const res = await call("/integrations/tracking", {
      method: "PUT", body: savePayload({ enabled: value }),
    });
    expect(res.status).toBe(400);
    expect(res.body.error.details).toMatchObject({ field: "enabled", expected: "boolean" });
    /* ── THE COERCION THAT WOULD HAVE BEEN WORST ───────────────────────────
       A non-empty string is truthy, so the STRING "false" would have switched
       tracking ON. */
    expect(await stored()).toBeNull();
  });

  test("enabled accepts only real booleans", async () => {
    expect((await call("/integrations/tracking", { method: "PUT", body: savePayload({ enabled: true }) })).status).toBe(200);
    expect((await call("/integrations/tracking", {
      method: "PUT", body: savePayload({ expectedRevision: 1, enabled: false }),
    })).status).toBe(200);
  });

  test.each([
    ["siteUrl", null],
    ["siteUrl", 123],
    ["siteUrl", ["https://a.example"]],
    ["siteUrl", { href: "https://a.example" }],
    ["siteUrl", true],
    ["trackingMode", null],
    ["trackingMode", 1],
    ["trackingMode", ["gtm"]],
    ["gtmContainerId", null],
    ["gtmContainerId", 1234],
    ["gtmContainerId", ["GTM-ABC1234"]],
    ["ga4MeasurementId", null],
    ["ga4MeasurementId", {}],
    ["note", null],
    ["note", 5],
    ["note", ["a note"]],
  ])("%s refuses a non-string value", async (field, value) => {
    const res = await call("/integrations/tracking", {
      method: "PUT", body: savePayload({ [field]: value }),
    });
    expect(res.status).toBe(400);
    expect(res.body.error.details).toMatchObject({ field, expected: "string" });
    expect(await stored()).toBeNull();
  });

  test("a Meta Pixel ID sent as a number is refused for precision, not shape", async () => {
    /* 15 digits fits a JSON number; 20 does not. Both are refused, because the
       contract is about the TYPE: a numeric literal long enough to matter has
       already lost digits by the time it reaches here. */
    for (const value of [123456789012345, 12345678901234567890]) {
      const res = await call("/integrations/tracking", {
        method: "PUT",
        body: savePayload({ trackingMode: "direct", gtmContainerId: "", metaPixelId: value }),
      });
      expect(res.status).toBe(400);
      expect(res.body.error.details).toMatchObject({ field: "metaPixelId", expected: "string" });
      expect(res.body.error.message).toMatch(/lose digits/i);
    }
    expect(await stored()).toBeNull();

    /* The same identifier as a string is accepted and kept digit for digit. */
    const ok = await call("/integrations/tracking", {
      method: "PUT",
      body: savePayload({ trackingMode: "direct", gtmContainerId: "", metaPixelId: "12345678901234567890" }),
    });
    expect(ok.status).toBe(200);
    expect(ok.body.config.metaPixelId).toBe("12345678901234567890");
  });

  test("an empty string still clears an optional identifier", async () => {
    await call("/integrations/tracking", {
      method: "PUT", body: savePayload({ ga4MeasurementId: GA4, metaPixelId: PIXEL }),
    });
    const res = await call("/integrations/tracking", {
      method: "PUT", body: { expectedRevision: 1, ga4MeasurementId: "" },
    });
    expect(res.status).toBe(200);
    expect(res.body.config.ga4MeasurementId).toBe("");
    /* Clearing is a change, so it earns a revision — unlike re-sending the same
       value, which does not. */
    expect(res.body.changed).toBe(true);
  });

  test.each([
    ["null", null],
    ["false", false],
    ["true", true],
    ["an empty string", ""],
    ["a numeric string", "1"],
    ["a float", 1.5],
    ["a negative", -1],
    ["Infinity as a string", "Infinity"],
    ["an array", [1]],
    ["an object", {}],
  ])("expectedRevision refuses %s", async (_label, value) => {
    await call("/integrations/tracking", { method: "PUT", body: savePayload() });
    const before = await stored();

    const res = await call("/integrations/tracking", {
      method: "PUT", body: savePayload({ expectedRevision: value, enabled: false }),
    });
    expect(res.status).toBe(400);
    expect(res.body.error.details.field).toBe("expectedRevision");
    /* ── THE MOST DANGEROUS COERCION OF ALL ────────────────────────────────
       `Number(null)`, `Number(false)` and `Number("")` are all 0, and 0 is the
       legitimate expected revision of a first save. Coercing any of them would
       have let a caller overwrite a configuration it had never read. */
    const after = await stored();
    expect(after.revision).toBe(before.revision);
    expect(after.enabled).toBe(before.enabled);
  });

  test("expectedRevision accepts a finite non-negative integer", async () => {
    expect((await call("/integrations/tracking", {
      method: "PUT", body: savePayload({ expectedRevision: 0 }),
    })).status).toBe(200);
    expect((await call("/integrations/tracking", {
      method: "PUT", body: savePayload({ expectedRevision: 1, enabled: false }),
    })).status).toBe(200);
  });

  test("a type refusal happens before either collection is touched", async () => {
    const configs = jest.spyOn(MarketingTrackingConfig, "findOneAndUpdate");
    const history = jest.spyOn(MarketingTrackingConfigHistory, "create");

    const res = await call("/integrations/tracking", {
      method: "PUT", body: savePayload({ enabled: "true", metaPixelId: 99999999 }),
    });
    expect(res.status).toBe(400);
    /* Not one write attempted, on either side — including the repair pass inside
       `reconcile`, which is why validation runs before it. */
    expect(configs).not.toHaveBeenCalled();
    expect(history).not.toHaveBeenCalled();

    configs.mockRestore();
    history.mockRestore();
  });

  test("the whole body must be an object", async () => {
    for (const body of [[], "a string", 42, null]) {
      const res = await call("/integrations/tracking", { method: "PUT", body });
      expect(res.status).toBe(400);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   2. IDENTIFIER AND URL VALIDATION
   ═══════════════════════════════════════════════════════════════════════════ */

describe("identifiers are validated and normalised", () => {
  test("valid GTM, GA4 and Meta identifiers are accepted", async () => {
    const res = await call("/integrations/tracking", {
      method: "PUT",
      body: savePayload({ ga4MeasurementId: GA4, metaPixelId: PIXEL }),
    });
    expect(res.status).toBe(200);
    expect(res.body.config).toMatchObject({
      gtmContainerId: GTM, ga4MeasurementId: GA4, metaPixelId: PIXEL, siteUrl: SITE,
    });
  });

  test("Google identifiers are normalised to upper case", async () => {
    const res = await call("/integrations/tracking", {
      method: "PUT",
      body: savePayload({ gtmContainerId: "  gtm-abc1234  ", trackingMode: "gtm" }),
    });
    expect(res.status).toBe(200);
    expect(res.body.config.gtmContainerId).toBe("GTM-ABC1234");
  });

  test.each([
    ["gtmContainerId", "GTM-", "too short"],
    ["gtmContainerId", "ABC1234", "no prefix"],
    ["gtmContainerId", "GTM-ABC1234EXTRALONGTAIL", "too long"],
    ["gtmContainerId", "GTM-ABC 1234", "contains a space"],
    ["ga4MeasurementId", "GA-ABCD1234", "wrong prefix"],
    ["ga4MeasurementId", "G-", "too short"],
    ["ga4MeasurementId", "G-ABCD1234-EXTRA", "trailing payload"],
    ["metaPixelId", "12345", "too short"],
    ["metaPixelId", "12345678901234567890123456", "too long"],
    ["metaPixelId", "12345678a", "not digits"],
    ["metaPixelId", "1234-5678-9012", "punctuated"],
  ])("%s rejects %s (%s)", async (field, value) => {
    const mode = field === "gtmContainerId" ? "gtm" : "direct";
    const body = savePayload({ trackingMode: mode, gtmContainerId: mode === "gtm" ? value : "" });
    if (mode === "direct") body[field] = value;
    const res = await call("/integrations/tracking", { method: "PUT", body });
    expect(res.status).toBe(400);
    expect(res.body.error.details.field).toBe(field);
  });

  test("an empty string clears an optional identifier", async () => {
    await call("/integrations/tracking", {
      method: "PUT", body: savePayload({ ga4MeasurementId: GA4, metaPixelId: PIXEL }),
    });
    const cleared = await call("/integrations/tracking", {
      method: "PUT", body: { expectedRevision: 1, metaPixelId: "" },
    });
    expect(cleared.status).toBe(200);
    expect(cleared.body.config.metaPixelId).toBe("");
    /* Not mentioning a field keeps it: clearing and omitting are different
       instructions. */
    expect(cleared.body.config.ga4MeasurementId).toBe(GA4);
  });
});

describe("the site URL is an https origin", () => {
  test("https is accepted and normalised to an origin", async () => {
    const res = await call("/integrations/tracking", {
      method: "PUT", body: savePayload({ siteUrl: "https://www.gravclothing.example/" }),
    });
    expect(res.status).toBe(200);
    expect(res.body.config.siteUrl).toBe("https://www.gravclothing.example");
  });

  test("production refuses http, even on localhost, even with the flag set", async () => {
    process.env.NODE_ENV = "production";
    process.env.MARKETING_TRACKING_ALLOW_LOCALHOST_HTTP = "true";
    for (const url of ["http://www.gravclothing.example", "http://localhost:3000"]) {
      expect(() => trackingConfig.normaliseSiteUrl(url, process.env)).toThrow(/must use https/i);
    }
  });

  test("the localhost development exception must be requested explicitly", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.MARKETING_TRACKING_ALLOW_LOCALHOST_HTTP;
    /* Not production, loopback host — and still refused, because the exception
       has not been asked for. */
    expect(() => trackingConfig.normaliseSiteUrl("http://localhost:3000", process.env))
      .toThrow(/must be requested explicitly/i);

    process.env.MARKETING_TRACKING_ALLOW_LOCALHOST_HTTP = "true";
    expect(trackingConfig.normaliseSiteUrl("http://localhost:3000", process.env))
      .toBe("http://localhost:3000");
    expect(trackingConfig.normaliseSiteUrl("http://127.0.0.1:8080", process.env))
      .toBe("http://127.0.0.1:8080");
    /* And the flag never extends beyond loopback. */
    expect(() => trackingConfig.normaliseSiteUrl("http://www.gravclothing.example", process.env))
      .toThrow(/loopback development host/i);
  });

  test.each([
    ["credentials", "https://user:pass@site.example"],
    ["a query string", "https://site.example?utm=1"],
    ["a fragment", "https://site.example#top"],
    ["a path", "https://site.example/shop"],
    ["a non-web scheme", "ftp://site.example"],
    ["javascript", "javascript:alert(1)"],
    ["nonsense", "not a url"],
  ])("%s is refused", async (_label, url) => {
    expect(() => trackingConfig.normaliseSiteUrl(url, { NODE_ENV: "development" })).toThrow();
  });

  test("a configured mode requires a site address", async () => {
    const res = await call("/integrations/tracking", {
      method: "PUT", body: { trackingMode: "gtm", gtmContainerId: GTM, expectedRevision: 0 },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.details.field).toBe("siteUrl");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   3. MODE RULES, AND THE DOUBLE-FIRING THEY PREVENT
   ═══════════════════════════════════════════════════════════════════════════ */

describe("a mode names one installation strategy", () => {
  test("GTM mode requires a container", async () => {
    const res = await call("/integrations/tracking", {
      method: "PUT", body: savePayload({ gtmContainerId: "" }),
    });
    expect(res.status).toBe(400);
    expect(res.body.error.details.field).toBe("gtmContainerId");
    expect(res.body.error.message).toMatch(/nothing would be installed/i);
  });

  test("GTM mode may record GA4 and Meta as documented, but installs only the container", async () => {
    const res = await call("/integrations/tracking", {
      method: "PUT",
      body: savePayload({ ga4MeasurementId: GA4, metaPixelId: PIXEL }),
    });
    expect(res.status).toBe(200);
    /* ── THE DOUBLE-FIRING RULE ────────────────────────────────────────────
       Both ids are stored, and the loader contract still says install only the
       container. A loader that also injected these would count every visit
       twice. */
    expect(res.body.config.loaderContract).toEqual({
      install: "gtm",
      activeDestinations: ["gtm"],
      documentedNotActive: ["ga4", "meta_pixel"],
    });
  });

  test("direct mode requires at least one destination", async () => {
    const res = await call("/integrations/tracking", {
      method: "PUT",
      body: savePayload({ trackingMode: "direct", gtmContainerId: "" }),
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/at least one destination/i);
  });

  test("direct mode refuses a container outright", async () => {
    const res = await call("/integrations/tracking", {
      method: "PUT",
      body: savePayload({ trackingMode: "direct", gtmContainerId: GTM, ga4MeasurementId: GA4 }),
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/counted twice/i);
    expect(res.body.error.details.field).toBe("gtmContainerId");
  });

  test("direct mode installs exactly the destinations it names", async () => {
    const res = await call("/integrations/tracking", {
      method: "PUT",
      body: savePayload({ trackingMode: "direct", gtmContainerId: "", ga4MeasurementId: GA4 }),
    });
    expect(res.body.config.loaderContract).toEqual({
      install: "direct", activeDestinations: ["ga4"], documentedNotActive: [],
    });

    const both = await call("/integrations/tracking", {
      method: "PUT", body: { expectedRevision: 1, metaPixelId: PIXEL },
    });
    expect(both.body.config.loaderContract.activeDestinations).toEqual(["ga4", "meta_pixel"]);
    expect(both.body.config.loaderContract.install).toBe("direct");
  });

  test("disabled mode activates nothing, even with identifiers stored", async () => {
    await call("/integrations/tracking", {
      method: "PUT", body: savePayload({ ga4MeasurementId: GA4 }),
    });
    const off = await call("/integrations/tracking", {
      method: "PUT", body: { expectedRevision: 1, trackingMode: "disabled", enabled: false },
    });
    expect(off.status).toBe(200);
    /* The identifiers are kept so re-enabling does not need them retyped, and
       none of them counts as live. */
    expect(off.body.config.gtmContainerId).toBe(GTM);
    expect(off.body.config.ga4MeasurementId).toBe(GA4);
    expect(off.body.config.loaderContract).toEqual({
      install: "none", activeDestinations: [], documentedNotActive: [],
    });
    expect(off.body.config.verification.state).toBe("not_configured");
  });

  test("a disabled configuration cannot also be enabled", async () => {
    const res = await call("/integrations/tracking", {
      method: "PUT", body: { trackingMode: "disabled", enabled: true, expectedRevision: 0 },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.details.field).toBe("enabled");
  });

  test("switching a configuration off deactivates it without deleting it", async () => {
    await call("/integrations/tracking", { method: "PUT", body: savePayload() });
    const off = await call("/integrations/tracking", {
      method: "PUT", body: { expectedRevision: 1, enabled: false },
    });
    expect(off.body.config.enabled).toBe(false);
    expect(off.body.config.loaderContract.install).toBe("none");
    expect(off.body.config.trackingMode).toBe("gtm");
  });

  test("an unknown mode is refused", async () => {
    const res = await call("/integrations/tracking", {
      method: "PUT", body: savePayload({ trackingMode: "gtag" }),
    });
    expect(res.status).toBe(400);
    expect(res.body.error.details.accepted).toEqual(TRACKING_MODE_CODES);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   4. WHAT IT REFUSES TO CLAIM
   ═══════════════════════════════════════════════════════════════════════════ */

describe("a saved identifier is never called connected or verified", () => {
  test("a fresh company is not configured", async () => {
    const res = await call("/integrations/tracking", { user: MARKETER });
    expect(res.status).toBe(200);
    expect(res.body.config.configured).toBe(false);
    expect(res.body.config.verification.state).toBe("not_configured");
    expect(res.body.config.revision).toBe(0);
  });

  test("a saved configuration is saved_unverified and says so in words", async () => {
    const res = await call("/integrations/tracking", { method: "PUT", body: savePayload() });
    expect(res.body.config.verification.state).toBe("saved_unverified");
    expect(res.body.config.verification.checkedAt).toBeNull();
    expect(res.body.config.verification.safeMessage).toMatch(/not confirmed to be installed/i);
  });

  test("nothing in the payload ever says connected, installed or verified", async () => {
    await call("/integrations/tracking", { method: "PUT", body: savePayload({ ga4MeasurementId: GA4 }) });
    const res = await call("/integrations/tracking");
    const text = JSON.stringify(res.body).toLowerCase();
    expect(text).not.toContain("\"connected\"");
    expect(text).not.toContain("isconnected");
    expect(text).not.toContain("\"installed\"");
    /* `verified` appears only as an unreached value in the served vocabulary. */
    expect(res.body.config.verification.state).not.toBe("verified");
  });

  test("verified cannot be produced by saving, whatever is sent", async () => {
    const res = await call("/integrations/tracking", {
      method: "PUT", body: savePayload({ verification: { state: "verified" } }),
    });
    /* `verification` is not an accepted field at all. */
    expect(res.status).toBe(400);
    expect(res.body.error.details.unknown).toContain("verification");

    await call("/integrations/tracking", { method: "PUT", body: savePayload() });
    expect((await MarketingTrackingConfig.findOne({ companyId: A })).verification.state)
      .toBe("saved_unverified");
  });

  test("the service refuses to write a verified state", () => {
    expect(trackingConfig.verificationFor({ trackingMode: "gtm" }).state).toBe("saved_unverified");
    expect(trackingConfig.verificationFor({ trackingMode: "disabled" }).state).toBe("not_configured");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   5. PERMISSION
   ═══════════════════════════════════════════════════════════════════════════ */

describe("reading is open to Marketing; changing needs an administrator", () => {
  test("a marketing user may read", async () => {
    await call("/integrations/tracking", { method: "PUT", body: savePayload() });
    const res = await call("/integrations/tracking", { user: MARKETER });
    expect(res.status).toBe(200);
    expect(res.body.config.gtmContainerId).toBe(GTM);
    /* And is told they may not change it, so a client renders a read-only view
       rather than offering a save that will be refused. */
    expect(res.body.canConfigure).toBe(false);
  });

  test("a marketing user may not change it", async () => {
    const res = await call("/integrations/tracking", {
      method: "PUT", user: MARKETER, body: savePayload(),
    });
    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/needs an administrator/i);
    expect(await MarketingTrackingConfig.countDocuments({})).toBe(0);
  });

  test("an administrator and a CEO may change it", async () => {
    expect((await call("/integrations/tracking", { method: "PUT", user: ADMIN, body: savePayload() })).status).toBe(200);
    expect((await call("/integrations/tracking", {
      method: "PUT", user: CEO, body: { expectedRevision: 1, enabled: false },
    })).status).toBe(200);
    expect((await call("/integrations/tracking", { user: ADMIN })).body.canConfigure).toBe(true);
  });

  test("a flagged platform administrator may change it", async () => {
    const res = await call("/integrations/tracking", {
      method: "PUT",
      user: { ...MARKETER, isAdmin: true },
      body: savePayload(),
    });
    expect(res.status).toBe(200);
  });

  test("an unauthenticated caller is refused at every route", async () => {
    for (const path of ["/integrations/tracking", "/integrations/tracking/history"]) {
      expect((await fetch(`${base}${path}`)).status).toBe(401);
    }
    const put = await fetch(`${base}/integrations/tracking`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    expect(put.status).toBe(401);
  });

  test("a role outside the Marketing allowlist is refused", async () => {
    const res = await call("/integrations/tracking", { user: { ...MARKETER, role: "store_manager" } });
    expect(res.status).toBe(403);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   6. OPTIMISTIC CONCURRENCY
   ═══════════════════════════════════════════════════════════════════════════ */

describe("two administrators cannot silently overwrite each other", () => {
  test("a save must state the revision it is replacing", async () => {
    const res = await call("/integrations/tracking", {
      method: "PUT", body: { siteUrl: SITE, trackingMode: "gtm", gtmContainerId: GTM },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.details.field).toBe("expectedRevision");
  });

  test("a stale revision is refused with the current one", async () => {
    await call("/integrations/tracking", { method: "PUT", body: savePayload() });

    /* A second administrator who loaded revision 0 before the first saved. */
    const stale = await call("/integrations/tracking", {
      method: "PUT", user: CEO, body: savePayload({ gtmContainerId: "GTM-ZZZ9999" }),
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.details.currentRevision).toBe(1);
    expect(stale.body.error.details.sentRevision).toBe(0);
    expect(stale.body.error.message).toMatch(/reload it and reapply/i);

    /* The first administrator's value stands. */
    expect((await call("/integrations/tracking")).body.config.gtmContainerId).toBe(GTM);
  });

  test("the revision advances by one per real change and appears in the read", async () => {
    /* Each save must actually change something: an unchanged submission is a
       no-op and deliberately consumes no revision. */
    const containers = ["GTM-AAA1111", "GTM-BBB2222", "GTM-CCC3333"];
    for (const [i, gtmContainerId] of containers.entries()) {
      const res = await call("/integrations/tracking", {
        method: "PUT", body: savePayload({ expectedRevision: i, gtmContainerId }),
      });
      expect(res.body.revision).toBe(i + 1);
      expect(res.body.changed).toBe(true);
    }
    expect((await call("/integrations/tracking")).body.config.revision).toBe(3);
  });

  test("a non-integer or negative expected revision is refused", async () => {
    for (const bad of ["one", -1, 1.5, null]) {
      const res = await call("/integrations/tracking", {
        method: "PUT", body: savePayload({ expectedRevision: bad }),
      });
      expect(res.status).toBe(400);
    }
  });

  test("concurrent saves produce one winner and one refusal, never a lost write", async () => {
    await call("/integrations/tracking", { method: "PUT", body: savePayload() });
    const results = await Promise.allSettled([
      call("/integrations/tracking", { method: "PUT", body: savePayload({ expectedRevision: 1, gtmContainerId: "GTM-AAA1111" }) }),
      call("/integrations/tracking", { method: "PUT", body: savePayload({ expectedRevision: 1, gtmContainerId: "GTM-BBB2222" }) }),
    ]);
    const statuses = results.map((r) => r.value.status).sort();
    expect(statuses).toEqual([200, 409]);
    expect(await MarketingTrackingConfigHistory.countDocuments({ companyId: A, revision: 2 })).toBe(1);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   7. HISTORY
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the history is append-only, company-scoped and paginated", () => {
  test("every save appends one row showing before and after", async () => {
    await call("/integrations/tracking", { method: "PUT", body: savePayload({ note: "initial setup" }) });
    await call("/integrations/tracking", {
      method: "PUT", user: CEO, body: { expectedRevision: 1, enabled: false, note: "paused for audit" },
    });

    const res = await call("/integrations/tracking/history");
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(2);
    /* Newest first. */
    expect(res.body.rows[0]).toMatchObject({ revision: 2, actor: "Cee", note: "paused for audit" });
    expect(res.body.rows[0].previous.enabled).toBe(true);
    expect(res.body.rows[0].resulting.enabled).toBe(false);
    expect(res.body.rows[1]).toMatchObject({ revision: 1, actor: "Ada", note: "initial setup" });
    expect(res.body.rows[1].previous).toBeNull();
  });

  test("a history row cannot be edited or deleted", async () => {
    await call("/integrations/tracking", { method: "PUT", body: savePayload() });
    const row = await MarketingTrackingConfigHistory.findOne({ companyId: A });

    await expect(MarketingTrackingConfigHistory.updateOne({ _id: row._id }, { $set: { note: "rewritten" } }))
      .rejects.toThrow(HISTORY_IMMUTABLE_MESSAGE);
    await expect(MarketingTrackingConfigHistory.deleteOne({ _id: row._id }))
      .rejects.toThrow(HISTORY_IMMUTABLE_MESSAGE);
    row.note = "rewritten";
    await expect(row.save()).rejects.toThrow(HISTORY_IMMUTABLE_MESSAGE);
  });

  test("history is cursor-paginated and bounded", async () => {
    for (let i = 0; i < 7; i += 1) {
      await call("/integrations/tracking", {
        /* A distinct pixel each time, so every save is a real change and earns a
           revision. */
        method: "PUT",
        body: savePayload({ expectedRevision: i, metaPixelId: String(100000000 + i) }),
      });
    }
    const seen = [];
    let cursor = null;
    do {
      const page = await call(`/integrations/tracking/history?limit=2${cursor ? `&cursor=${cursor}` : ""}`);
      seen.push(...page.body.rows.map((r) => r.revision));
      cursor = page.body.nextCursor;
    } while (cursor);

    expect(seen).toEqual([7, 6, 5, 4, 3, 2, 1]);
    const bounded = await call("/integrations/tracking/history?limit=100000");
    expect(bounded.body.page.maxSize).toBe(trackingConfig.MAX_HISTORY_PAGE);
  });

  test("a malformed cursor is refused", async () => {
    const res = await call("/integrations/tracking/history?cursor=nonsense");
    expect(res.status).toBe(400);
  });

  test("a history row holds no secret-shaped field", async () => {
    await call("/integrations/tracking", { method: "PUT", body: savePayload({ ga4MeasurementId: GA4 }) });
    const row = await MarketingTrackingConfigHistory.findOne({ companyId: A }).lean();
    expect(Object.keys(row.resulting).sort()).toEqual([
      "enabled", "ga4MeasurementId", "gtmContainerId", "metaPixelId", "siteUrl", "trackingMode",
    ]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   8. COMPANY ISOLATION
   ═══════════════════════════════════════════════════════════════════════════ */

describe("one company's configuration is invisible to another", () => {
  test("current settings do not cross companies", async () => {
    await call("/integrations/tracking", { method: "PUT", body: savePayload() });
    await call("/integrations/tracking", {
      method: "PUT", company: B, body: savePayload({ gtmContainerId: "GTM-OTHER11", siteUrl: "https://other.example" }),
    });

    const mine = await call("/integrations/tracking");
    expect(mine.body.config.gtmContainerId).toBe(GTM);
    expect(mine.body.config.siteUrl).toBe(SITE);

    const theirs = await call("/integrations/tracking", { company: B });
    expect(theirs.body.config.gtmContainerId).toBe("GTM-OTHER11");
    expect(JSON.stringify(mine.body)).not.toContain("other.example");
  });

  test("history does not cross companies", async () => {
    for (let i = 0; i < 3; i += 1) {
      await call("/integrations/tracking", { method: "PUT", company: B, body: savePayload({ expectedRevision: i }) });
    }
    await call("/integrations/tracking", { method: "PUT", body: savePayload() });

    const mine = await call("/integrations/tracking/history");
    expect(mine.body.rows).toHaveLength(1);
    expect(mine.body.rows[0].revision).toBe(1);
  });

  test("a cursor from another company reveals nothing", async () => {
    await call("/integrations/tracking", { method: "PUT", company: B, body: savePayload() });
    const theirRow = await MarketingTrackingConfigHistory.findOne({ companyId: B });
    await call("/integrations/tracking", { method: "PUT", body: savePayload() });

    const res = await call(`/integrations/tracking/history?cursor=${theirRow._id}`);
    expect(res.status).toBe(200);
    expect(res.body.rows.every((r) => r.resulting.siteUrl === SITE)).toBe(true);
    expect(await MarketingTrackingConfigHistory.countDocuments({ companyId: B })).toBe(1);
  });

  test("every service read and write requires a company", async () => {
    for (const fn of [
      () => trackingConfig.get({}),
      () => trackingConfig.save({ payload: savePayload() }),
      () => trackingConfig.history({}),
      () => trackingConfig.reconcile({}),
    ]) {
      await expect(fn()).rejects.toMatchObject({ code: "TENANT_MEMBERSHIP_UNPROVEN" });
    }
  });

  test("one configuration per company is enforced by the database", async () => {
    await MarketingTrackingConfig.create({ companyId: A, trackingMode: "disabled" });
    await expect(MarketingTrackingConfig.create({ companyId: A, trackingMode: "disabled" }))
      .rejects.toMatchObject({ code: 11000 });
    await expect(MarketingTrackingConfig.create({ companyId: B, trackingMode: "disabled" }))
      .resolves.toBeDefined();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   9. AN INTERRUPTED WRITE
   ═══════════════════════════════════════════════════════════════════════════ */

describe("an interrupted save is never reported as changing nothing", () => {
  /* ── THE SENTENCE THAT MUST NEVER BE RETURNED ─────────────────────────────
     The history row is written before the current record, so a failure between
     them leaves a DURABLE decision the setting has not caught up with. Saying
     "nothing was changed" would be false, and a caller acting on it would retry
     a change that is already recorded or abandon one that is about to apply
     itself. Every test here checks what the caller is told as well as what the
     database holds. */

  const primeRevisionOne = () => call("/integrations/tracking", { method: "PUT", body: savePayload() });

  test("a thrown current-record write recovers immediately and says so", async () => {
    await primeRevisionOne();
    const spy = jest.spyOn(MarketingTrackingConfig, "findOneAndUpdate")
      .mockRejectedValueOnce(new Error("connection lost after the trail was written"));

    const res = await call("/integrations/tracking", {
      method: "PUT", body: { expectedRevision: 1, enabled: false, note: "the interrupted one" },
    });
    spy.mockRestore();

    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(true);
    /* Disclosed, not hidden. */
    expect(res.body.recovered).toBe(true);
    expect(res.body.revision).toBe(2);
    expect(res.body.config.revision).toBe(2);
    expect(res.body.config.enabled).toBe(false);
    /* One decision, one history row. */
    expect(await MarketingTrackingConfigHistory.countDocuments({ companyId: A })).toBe(2);
  });

  test("a current-record write that matches nothing recovers the same way", async () => {
    await primeRevisionOne();
    /* Not a thrown error: an update whose revision fence matched no document.
       Same consequence, same repair, and it must not be mistaken for success. */
    const spy = jest.spyOn(MarketingTrackingConfig, "findOneAndUpdate")
      .mockResolvedValueOnce(null);

    const res = await call("/integrations/tracking", {
      method: "PUT", body: { expectedRevision: 1, enabled: false },
    });
    spy.mockRestore();

    expect(res.status).toBe(200);
    expect(res.body.recovered).toBe(true);
    expect(res.body.config.revision).toBe(2);
    expect(res.body.config.enabled).toBe(false);
  });

  test("a normal save reports recovered false", async () => {
    const res = await primeRevisionOne();
    expect(res.status).toBe(200);
    expect(res.body.recovered).toBe(false);
    expect(res.body.changed).toBe(true);
    expect(res.body.noop).toBe(false);
  });

  test("when recovery cannot finish, the answer is repair-pending and truthful", async () => {
    await primeRevisionOne();
    /* Both the save's own write AND the repair inside it fail. */
    const spy = jest.spyOn(MarketingTrackingConfig, "findOneAndUpdate")
      .mockRejectedValueOnce(new Error("connection lost"))
      .mockRejectedValueOnce(new Error("still lost"));

    const res = await call("/integrations/tracking", {
      method: "PUT", body: { expectedRevision: 1, enabled: false, note: "interrupted twice" },
    });
    spy.mockRestore();

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("TRACKING_CONFIG_REPAIR_PENDING");
    /* ── THE WORDING ───────────────────────────────────────────────────────
       It must say the decision was recorded, must not claim nothing changed,
       and must tell the caller to reload before retrying. */
    const message = res.body.error.message;
    expect(message).toMatch(/recorded as revision 2/i);
    expect(message).toMatch(/not yet confirmed/i);
    expect(message).toMatch(/nothing has been lost/i);
    expect(message).toMatch(/reload the configuration before trying again/i);
    expect(message).not.toMatch(/nothing was changed/i);
    expect(message).not.toMatch(/failed to save|could not save/i);

    /* No stack and no database message. */
    expect(JSON.stringify(res.body)).not.toMatch(/connection lost|still lost|node_modules|at Object\./);
    expect(res.body.error.details).toMatchObject({ revision: 2, previousRevision: 1 });

    /* The decision really is recorded, and the setting really has not caught
       up — which is exactly what the message says. */
    expect(await MarketingTrackingConfigHistory.countDocuments({ companyId: A })).toBe(2);
    expect((await MarketingTrackingConfig.findOne({ companyId: A })).revision).toBe(1);
  });

  test("after a repair-pending answer, the next ordinary read applies the decision", async () => {
    await primeRevisionOne();
    const spy = jest.spyOn(MarketingTrackingConfig, "findOneAndUpdate")
      .mockRejectedValueOnce(new Error("lost"))
      .mockRejectedValueOnce(new Error("lost"));
    const pending = await call("/integrations/tracking", {
      method: "PUT", body: { expectedRevision: 1, enabled: false },
    });
    spy.mockRestore();
    expect(pending.status).toBe(503);

    const read = await call("/integrations/tracking");
    expect(read.body.config.revision).toBe(2);
    expect(read.body.config.enabled).toBe(false);
    expect(read.body.config.repaired).toBe(true);

    /* Idempotent: a second read repairs nothing and appends nothing. */
    expect((await call("/integrations/tracking")).body.config.repaired).toBe(false);
    expect(await MarketingTrackingConfigHistory.countDocuments({ companyId: A })).toBe(2);
  });

  test("a repaired configuration can be saved on top of, at its new revision", async () => {
    await primeRevisionOne();
    const spy = jest.spyOn(MarketingTrackingConfig, "findOneAndUpdate")
      .mockRejectedValueOnce(new Error("lost"))
      .mockRejectedValueOnce(new Error("lost"));
    await call("/integrations/tracking", { method: "PUT", body: { expectedRevision: 1, enabled: false } });
    spy.mockRestore();

    /* The stale revision is refused; the repaired one is accepted. */
    expect((await call("/integrations/tracking", {
      method: "PUT", body: { expectedRevision: 1, enabled: true },
    })).status).toBe(409);
    const ok = await call("/integrations/tracking", {
      method: "PUT", body: { expectedRevision: 2, enabled: true },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.revision).toBe(3);
  });

  test("the repair never applies another company's history", async () => {
    await call("/integrations/tracking", { method: "PUT", company: B, body: savePayload({ siteUrl: "https://other.example" }) });
    await primeRevisionOne();
    const spy = jest.spyOn(MarketingTrackingConfig, "findOneAndUpdate")
      .mockRejectedValueOnce(new Error("lost"))
      .mockRejectedValueOnce(new Error("lost"));
    await call("/integrations/tracking", { method: "PUT", body: { expectedRevision: 1, enabled: false } });
    spy.mockRestore();

    const mine = await call("/integrations/tracking");
    expect(mine.body.config.siteUrl).toBe(SITE);
    const theirs = await call("/integrations/tracking", { company: B });
    expect(theirs.body.config.siteUrl).toBe("https://other.example");
    expect(theirs.body.config.revision).toBe(1);
  });

  test("a refused save leaves neither collection changed", async () => {
    await primeRevisionOne();
    const before = await MarketingTrackingConfig.findOne({ companyId: A }).lean();

    for (const body of [
      savePayload({ expectedRevision: 1, gtmContainerId: "nope" }),
      savePayload({ expectedRevision: 1, metaAccessToken: "x" }),
      savePayload({ expectedRevision: 1, trackingMode: "direct", ga4MeasurementId: "" }),
      savePayload({ expectedRevision: 99 }),
      savePayload({ expectedRevision: 1, enabled: "yes" }),
      savePayload({ expectedRevision: 1, metaPixelId: 123456789012345 }),
    ]) {
      const res = await call("/integrations/tracking", { method: "PUT", body });
      expect(res.status).toBeGreaterThanOrEqual(400);
    }

    const after = await MarketingTrackingConfig.findOne({ companyId: A }).lean();
    expect(after.revision).toBe(before.revision);
    expect(after.gtmContainerId).toBe(before.gtmContainerId);
    expect(await MarketingTrackingConfigHistory.countDocuments({ companyId: A })).toBe(1);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   9b. A SAVE THAT CHANGES NOTHING
   ═══════════════════════════════════════════════════════════════════════════ */

describe("an unchanged submission is not a revision", () => {
  test("re-submitting the same configuration consumes no revision and appends nothing", async () => {
    const first = await call("/integrations/tracking", { method: "PUT", body: savePayload() });
    expect(first.body.revision).toBe(1);

    for (let i = 0; i < 3; i += 1) {
      const again = await call("/integrations/tracking", {
        method: "PUT", body: savePayload({ expectedRevision: 1 }),
      });
      expect(again.status).toBe(200);
      expect(again.body.changed).toBe(false);
      expect(again.body.noop).toBe(true);
      expect(again.body.revision).toBe(1);
    }

    expect(await MarketingTrackingConfigHistory.countDocuments({ companyId: A })).toBe(1);
    expect((await MarketingTrackingConfig.findOne({ companyId: A })).revision).toBe(1);
  });

  test("a no-op does not even touch the current record", async () => {
    await call("/integrations/tracking", { method: "PUT", body: savePayload() });
    const before = await MarketingTrackingConfig.findOne({ companyId: A }).lean();

    const spy = jest.spyOn(MarketingTrackingConfig, "findOneAndUpdate");
    const res = await call("/integrations/tracking", { method: "PUT", body: savePayload({ expectedRevision: 1 }) });
    expect(res.body.noop).toBe(true);
    /* Not written at all — not even an idempotent rewrite of the same values,
       which would move `updatedAt` and make the record look edited. */
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();

    const after = await MarketingTrackingConfig.findOne({ companyId: A }).lean();
    expect(String(after.updatedAt)).toBe(String(before.updatedAt));
    expect(String(after.configuredAt)).toBe(String(before.configuredAt));
  });

  test("a note alone does not create a revision", async () => {
    await call("/integrations/tracking", { method: "PUT", body: savePayload() });
    const res = await call("/integrations/tracking", {
      method: "PUT",
      body: { expectedRevision: 1, note: "just leaving a remark about an unchanged setting" },
    });
    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(false);
    expect(res.body.noop).toBe(true);
    expect(res.body.revision).toBe(1);

    /* Notes accompany real changes. No row was appended, so the note is not
       recorded — and the response says `changed: false` rather than implying it
       was. */
    expect(await MarketingTrackingConfigHistory.countDocuments({ companyId: A })).toBe(1);
    expect((await MarketingTrackingConfigHistory.findOne({ companyId: A })).note).toBe("");
  });

  test("a first save asking only for the defaults creates nothing", async () => {
    const res = await call("/integrations/tracking", {
      method: "PUT", body: { expectedRevision: 0, trackingMode: "disabled", enabled: false },
    });
    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(false);
    expect(res.body.noop).toBe(true);
    expect(res.body.revision).toBe(0);
    expect(await MarketingTrackingConfig.countDocuments({ companyId: A })).toBe(0);
    expect(await MarketingTrackingConfigHistory.countDocuments({ companyId: A })).toBe(0);
  });

  test("one changed field is enough to earn a revision", async () => {
    await call("/integrations/tracking", { method: "PUT", body: savePayload() });
    const res = await call("/integrations/tracking", {
      method: "PUT", body: savePayload({ expectedRevision: 1, gtmContainerId: "GTM-XYZ9999" }),
    });
    expect(res.body.changed).toBe(true);
    expect(res.body.noop).toBe(false);
    expect(res.body.revision).toBe(2);
  });

  test("the comparison is over the safe configuration, field by field", () => {
    const base = {
      siteUrl: SITE, trackingMode: "gtm", gtmContainerId: GTM,
      ga4MeasurementId: "", metaPixelId: "", enabled: true,
    };
    expect(trackingConfig.deepEqualConfig(base, { ...base })).toBe(true);
    expect(trackingConfig.deepEqualConfig(base, { ...base, enabled: false })).toBe(false);
    expect(trackingConfig.deepEqualConfig(base, { ...base, metaPixelId: PIXEL })).toBe(false);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   10. BOUNDARIES
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the slice stays inside its boundary", () => {
  test("it makes no network call to any provider", async () => {
    const realFetch = global.fetch;
    const calls = [];
    global.fetch = (...args) => {
      const url = String(args[0]);
      /* The suite's own requests to its local test server are the only traffic
         allowed; anything reaching a provider is the failure. */
      if (!url.startsWith(base)) calls.push(url);
      return realFetch(...args);
    };
    try {
      await call("/integrations/tracking", { method: "PUT", body: savePayload({ ga4MeasurementId: GA4, metaPixelId: PIXEL }) });
      await call("/integrations/tracking");
      await call("/integrations/tracking/history");
    } finally {
      global.fetch = realFetch;
    }
    expect(calls).toEqual([]);
  });

  test("the service loads no HTTP client and no provider module", () => {
    const fs = require("fs");
    const source = fs.readFileSync(
      require.resolve("../../services/marketing/trackingConfig.service"), "utf8",
    );
    const requires = [...source.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]);
    for (const path of requires) {
      expect(path).not.toMatch(/axios|node-fetch|googleapis|facebook|https?$/);
      expect(path).not.toMatch(/mautic/i);
      expect(path).not.toMatch(/CMS_Models\/Sales|services\/sales\//);
    }
    expect(requires.sort()).toEqual([
      "../../constants/marketing",
      "../../models/CMS_Models/Marketing/MarketingTrackingConfig",
      "../storePurchase/errors",
    ]);
  });

  test("nothing it serves is a script tag or an HTML snippet", async () => {
    await call("/integrations/tracking", {
      method: "PUT", body: savePayload({ ga4MeasurementId: GA4, metaPixelId: PIXEL }),
    });
    const text = JSON.stringify((await call("/integrations/tracking")).body);
    expect(text).not.toContain("<script");
    expect(text).not.toContain("googletagmanager.com");
    expect(text).not.toContain("connect.facebook.net");
    expect(text).not.toMatch(/<[a-z]+[\s>]/i);
  });

  test("the router exposes exactly three routes", () => {
    const router = require("../../routes/CMS_Routes/Marketing/trackingIntegrations");
    const paths = router.stack
      .filter((l) => l.route)
      .map((l) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`);
    expect(paths.sort()).toEqual([
      "GET /integrations/tracking",
      "GET /integrations/tracking/history",
      "PUT /integrations/tracking",
    ]);
  });

  test("no Mautic, consent, handover or Sales collection is touched by a save", async () => {
    const before = await Promise.all([
      mongoose.connection.db.collection("marketing_consents").countDocuments(),
      mongoose.connection.db.collection("marketing_prospect_handovers").countDocuments(),
      mongoose.connection.db.collection("leads").countDocuments(),
    ]);
    await call("/integrations/tracking", { method: "PUT", body: savePayload() });
    const after = await Promise.all([
      mongoose.connection.db.collection("marketing_consents").countDocuments(),
      mongoose.connection.db.collection("marketing_prospect_handovers").countDocuments(),
      mongoose.connection.db.collection("leads").countDocuments(),
    ]);
    expect(after).toEqual(before);
  });
});
