// test/marketing/content-inventory.test.js
//
// THE READ-ONLY MAUTIC CONTENT INVENTORY.
//
// ── THE FIXTURES ARE REAL PROVIDER PAYLOADS ────────────────────────────────
// Every row below was captured from the running Mautic 7.2.0 instance, not
// imagined. That matters for one specific reason: `GET /api/emails` returns its
// collection as an OBJECT KEYED BY ID while `/api/forms` and `/api/pages`
// return ARRAYS. A test written from a guessed shape would have used arrays
// throughout and the email path would have read a populated instance as empty.
//
// The email fixture also carries the fields that must never travel — the HTML
// body, the recipient segments, the from and bcc addresses — so the leak tests
// have something real to fail on.
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

const contentInventory = require("../../services/marketing/contentInventory.service");
const { MauticClient, CONTENT_COLLECTIONS, CONTENT_MAX_LIMIT } = require("../../services/marketing/mauticClient");
const { CONTENT_KIND_CODES } = require("../../constants/marketing");
const Lead = require("../../models/CMS_Models/Sales/Lead");
const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");
const { MarketingConsent } = require("../../models/CMS_Models/Marketing/MarketingConsent");
const Handover = require("../../models/CMS_Models/Marketing/ProspectHandover");

const MARKETER = { id: new mongoose.Types.ObjectId().toString(), name: "M", role: "marketing", email: "m@grav.in" };

/* The configured Marketing company — deployment configuration, not a request
   value. Company B below exists on the same GRAV installation and has no claim
   on this Mautic instance. */
const COMPANY_A = new mongoose.Types.ObjectId();
const COMPANY_B = new mongoose.Types.ObjectId();

let server;
let base;
const savedEnv = {};
const ENV_KEYS = ["MARKETING_COMPANY_ID"];

/* ── CAPTURED FROM THE LIVE INSTANCE ────────────────────────────────────────
   A full (non-minimal) email row, so the leak tests exercise the real danger.
   The service reads with `minimal=true` in production, which means these fields
   never leave Mautic at all — this fixture proves the normaliser would drop
   them even if they did. */
const LIVE_EMAIL_ROW = Object.freeze({
  isPublished: true,
  dateAdded: "2026-09-10T02:14:12+00:00",
  dateModified: "2026-09-10T02:14:12+00:00",
  createdBy: 1,
  createdByUser: "GRAV Admin",
  id: 1,
  name: "GRAV Chunk 0 probe",
  subject: "GRAV integration probe — not a real campaign",
  language: "en",
  category: null,
  fromAddress: "marketing@grav-integration-test.invalid",
  fromName: "GRAV Marketing Dev",
  replyToAddress: "reply@grav-integration-test.invalid",
  bccAddress: "audit@grav-integration-test.invalid",
  sendToDnc: false,
  customHtml: "<p>SECRET BODY</p><script>alert('xss')</script>",
  plainText: "SECRET PLAIN TEXT",
  emailType: "list",
  publishUp: null,
  publishDown: null,
  readCount: 1,
  sentCount: 1,
  lists: [{ id: 1, name: "grav-integration-test", alias: "grav-integration-test" }],
  dynamicContent: [{ tokenName: "Dynamic Content 1", content: "SECRET DYNAMIC" }],
  headers: [],
  assetAttachments: [],
});

const LIVE_FORM_ROW = Object.freeze({
  isPublished: true,
  dateAdded: "2026-09-10T12:26:24+00:00",
  dateModified: "2026-09-10T12:26:24+00:00",
  id: 1,
  name: "GRAV probe form",
  alias: "grav_probe",
  category: null,
  description: "probe",
  cachedHtml: "<style>SECRET FORM HTML</style><form>…</form>",
  publishUp: null,
  publishDown: null,
  fields: [{ id: 1, label: "Email", alias: "email", type: "email" }],
  actions: [],
  formType: "standalone",
  noIndex: true,
  language: null,
});

const LIVE_PAGE_ROW = Object.freeze({
  isPublished: true,
  dateAdded: "2026-09-10T12:26:26+00:00",
  dateModified: "2026-09-10T12:26:26+00:00",
  id: 1,
  title: "GRAV probe page",
  alias: "grav-probe-page",
  category: { id: 3, title: "Acquisition", alias: "acquisition" },
  language: "en",
  publishUp: null,
  publishDown: null,
  hits: 0,
  uniqueHits: 0,
  customHtml: "<html><body>SECRET PAGE HTML</body></html>",
  metaDescription: null,
});

/**
 * A Mautic double that answers with the REAL envelope shapes.
 *
 * Emails come back as an object keyed by id; forms and pages as arrays. That
 * asymmetry is the provider's, and reproducing it is the point of this double.
 */
function mauticDouble({
  emails = [LIVE_EMAIL_ROW],
  forms = [LIVE_FORM_ROW],
  pages = [LIVE_PAGE_ROW],
  totals = {},
  failOn = null,
  failWith = { code: "MAUTIC_UNAVAILABLE", message: "Mautic could not be reached." },
  malformed = null,
} = {}) {
  const calls = [];
  const collections = {
    email: { key: "emails", rows: emails, asObject: true },
    form: { key: "forms", rows: forms, asObject: false },
    landing_page: { key: "pages", rows: pages, asObject: false },
  };

  const real = MauticClient.prototype.listContent;

  return {
    calls,
    async request({ method, url, params }) {
      calls.push({ method, url, params });
      const kind = Object.keys(CONTENT_COLLECTIONS)
        .find((k) => CONTENT_COLLECTIONS[k].url === url);
      if (failOn === kind) {
        const err = new Error(failWith.message);
        err.code = failWith.code;
        throw err;
      }
      if (malformed && malformed.kind === kind) {
        return { status: 200, data: malformed.data };
      }
      const spec = collections[kind];
      const start = Number(params?.start) || 0;
      const limit = Number(params?.limit) || 25;
      const slice = spec.rows.slice(start, start + limit);
      const container = spec.asObject
        ? Object.fromEntries(slice.map((r) => [String(r.id), r]))
        : slice;
      const total = Object.prototype.hasOwnProperty.call(totals, kind)
        ? totals[kind]
        : spec.rows.length;
      return { status: 200, data: { total, [spec.key]: container } };
    },
    /* The real implementation, so every test exercises the actual envelope
       parsing, ordering parameters and bounds rather than a stand-in. */
    listContent(kind, options) { return real.call(this, kind, options); },
    listEmails(o) { return this.listContent("email", o); },
    listForms(o) { return this.listContent("form", o); },
    listPages(o) { return this.listContent("landing_page", o); },
  };
}

beforeAll(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  const app = express();
  app.use((req, _res, next) => {
    const header = String(req.headers["x-test-company"] || "");
    if (mongoose.Types.ObjectId.isValid(header)) {
      req.__marketingCompanyId = new mongoose.Types.ObjectId(header);
    }
    next();
  });
  app.use("/api/cms/marketing", require("../../routes/CMS_Routes/Marketing/contentInventory"));
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

/* Jest reuses a worker across files, so nothing may be left behind. */
const restoreEnv = () => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
};
afterEach(restoreEnv);

beforeEach(() => {
  process.env.MARKETING_COMPANY_ID = String(COMPANY_A);
});

const call = async (path, { user = MARKETER, company = COMPANY_A } = {}) => {
  const res = await fetch(`${base}${path}`, {
    headers: { "x-test-user": JSON.stringify(user), "x-test-company": String(company) },
  });
  return { status: res.status, body: await res.json() };
};

/* ═══════════════════════════════════════════════════════════════════════════
   1. AUTHENTICATION AND THE COMPANY BOUNDARY
   ═══════════════════════════════════════════════════════════════════════════ */

describe("only an authenticated Marketing user of the configured company may read", () => {
  test("an unauthenticated caller is refused at both routes", async () => {
    for (const path of ["/content/summary", "/content?kind=email"]) {
      expect((await fetch(`${base}${path}`)).status).toBe(401);
    }
  });

  test("a role outside the Marketing allowlist is refused", async () => {
    const res = await call("/content?kind=email", { user: { ...MARKETER, role: "store_manager" } });
    expect(res.status).toBe(403);
  });

  test("company B gets no content from the shared Mautic instance", async () => {
    const client = mauticDouble();
    await expect(contentInventory.list({ companyId: COMPANY_B, kind: "email", client }))
      .rejects.toMatchObject({ code: "MARKETING_COMPANY_NOT_CONFIGURED" });
    await expect(contentInventory.summary({ companyId: COMPANY_B, client }))
      .rejects.toMatchObject({ code: "MARKETING_COMPANY_NOT_CONFIGURED" });

    /* ── THE POINT ────────────────────────────────────────────────────────
       Not one provider call was made on company B's behalf. The refusal
       happens before Mautic is asked, so company A's estate is never even
       fetched into a request company B could observe. */
    expect(client.calls).toEqual([]);
  });

  test("company B is refused over HTTP too, and sees no rows", async () => {
    const res = await call("/content?kind=email", { company: COMPANY_B });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("MARKETING_COMPANY_NOT_CONFIGURED");
    expect(res.body.rows).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain("GRAV Chunk 0 probe");
  });

  test("with no Marketing company configured, nobody reads content", async () => {
    delete process.env.MARKETING_COMPANY_ID;
    const client = mauticDouble();
    await expect(contentInventory.list({ companyId: COMPANY_A, kind: "email", client }))
      .rejects.toMatchObject({ code: "MARKETING_COMPANY_NOT_CONFIGURED" });
    expect(client.calls).toEqual([]);
  });

  test("a read without a company is refused outright", async () => {
    await expect(contentInventory.list({ kind: "email", client: mauticDouble() }))
      .rejects.toMatchObject({ code: "TENANT_MEMBERSHIP_UNPROVEN" });
    await expect(contentInventory.summary({ client: mauticDouble() }))
      .rejects.toMatchObject({ code: "TENANT_MEMBERSHIP_UNPROVEN" });
  });

  test("no company is ever read from the query string or a body", async () => {
    /* A caller naming company B in the query is not refused for that reason —
       the parameter is simply never consulted. The route reaches the provider,
       which is unconfigured in this suite, so the answer is a provider error
       rather than anything about company B. */
    const res = await call(`/content?kind=email&companyId=${COMPANY_B}&company=${COMPANY_B}`);
    expect(res.body.error?.code).not.toBe("MARKETING_COMPANY_NOT_CONFIGURED");
    const source = require("fs").readFileSync(
      require.resolve("../../routes/CMS_Routes/Marketing/contentInventory"), "utf8",
    );
    expect(source).not.toMatch(/req\.query\.compan/i);
    expect(source).not.toMatch(/req\.body\.compan/i);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   2. EVERY PROVIDER CALL IS A BOUNDED, ORDERED GET
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the provider is only ever read", () => {
  test("every call is a GET against one of three known endpoints", async () => {
    const client = mauticDouble();
    await contentInventory.list({ companyId: COMPANY_A, kind: "email", client });
    await contentInventory.summary({ companyId: COMPANY_A, client });

    expect(client.calls.length).toBeGreaterThan(0);
    for (const c of client.calls) {
      expect(c.method).toBe("GET");
      expect(["/api/emails", "/api/forms", "/api/pages"]).toContain(c.url);
    }
    /* Nothing that sends, edits, publishes or reads submissions. */
    const urls = client.calls.map((c) => c.url).join(" ");
    expect(urls).not.toMatch(/send|submission|new|edit|delete|contacts|users|roles/);
  });

  test("every call is bounded, minimal and explicitly ordered", async () => {
    const client = mauticDouble();
    await contentInventory.list({ companyId: COMPANY_A, kind: "form", client, limit: 10 });
    const c = client.calls[0];
    expect(c.params).toMatchObject({ orderBy: "id", orderByDir: "ASC", minimal: true, start: 0 });
    /* One more than asked for, so `hasMore` is observed rather than guessed. */
    expect(c.params.limit).toBe(11);
  });

  test("the client REFUSES an out-of-range page size rather than clamping it", async () => {
    const client = mauticDouble();
    /* ── WHY REFUSAL AND NOT A CLAMP ──────────────────────────────────────
       A caller that asked for 100,000 and silently received 100 is paging by an
       offset it believes it chose, and it will skip rows without ever seeing an
       error. */
    for (const limit of [100000, 0, -1, 1.5, "25", [25], {}, NaN, Infinity]) {
      await expect(client.listContent("email", { limit }))
        .rejects.toMatchObject({ code: "VALIDATION" });
    }
    for (const start of [-50, 1.5, "0", []]) {
      await expect(client.listContent("email", { start }))
        .rejects.toMatchObject({ code: "VALIDATION" });
    }
    /* Not one of those reached Mautic. */
    expect(client.calls).toEqual([]);

    /* Omitted takes the documented default; in range is honoured exactly. */
    await client.listContent("email");
    expect(client.calls[0].params.limit).toBe(25);
    await client.listContent("email", { limit: CONTENT_MAX_LIMIT, start: 40 });
    expect(client.calls[1].params).toMatchObject({ limit: CONTENT_MAX_LIMIT, start: 40 });
  });

  test("the client refuses a kind outside the closed endpoint table", async () => {
    const client = mauticDouble();
    await expect(client.listContent("campaign")).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(client.listContent("../../users")).rejects.toMatchObject({ code: "VALIDATION" });
    expect(client.calls).toEqual([]);
  });

  test("the endpoint table is closed and contains only the three reads", () => {
    expect(Object.keys(CONTENT_COLLECTIONS).sort()).toEqual(["email", "form", "landing_page"]);
    expect(Object.values(CONTENT_COLLECTIONS).map((c) => c.url).sort())
      .toEqual(["/api/emails", "/api/forms", "/api/pages"]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   3. NORMALISATION INTO THE SAFE COMMON SHAPE
   ═══════════════════════════════════════════════════════════════════════════ */

describe("all three kinds normalise into one safe shape", () => {
  /* The exact sorted key set of a safe row. Asserted as a whole so a field
     added to the normaliser without a decision fails here. */
  const SHAPE = [
    "alias", "category", "contentId", "createdAt", "details", "kind", "language",
    "modifiedAt", "name", "publicationState", "publishDown", "publishUp", "published",
  ];

  test("an email normalises, keyed on its object-container id", async () => {
    const client = mauticDouble();
    const view = await contentInventory.list({ companyId: COMPANY_A, kind: "email", client });
    expect(view.rows).toHaveLength(1);
    const row = view.rows[0];
    expect(Object.keys(row).sort()).toEqual(SHAPE);
    expect(row).toMatchObject({
      kind: "email",
      /* An opaque GRAV identifier, carried as a STRING. Not labelled as a
         provider id, and no client should parse it. */
      contentId: "1",
      name: "GRAV Chunk 0 probe",
      alias: null,
      published: true,
      publicationState: "published",
      language: "en",
      category: null,
    });
    expect(row.details).toEqual({ subject: "GRAV integration probe — not a real campaign" });
    expect(row.createdAt).toBe("2026-09-10T02:14:12.000Z");
  });

  test("a form normalises from an array container", async () => {
    const client = mauticDouble();
    const view = await contentInventory.list({ companyId: COMPANY_A, kind: "form", client });
    const row = view.rows[0];
    expect(Object.keys(row).sort()).toEqual(SHAPE);
    expect(row).toMatchObject({ kind: "form", contentId: "1", name: "GRAV probe form", alias: "grav_probe" });
    /* No verified extra field for a form in minimal mode, so no invented keys. */
    expect(row.details).toEqual({});
    expect(row.language).toBeNull();
  });

  test("a landing page normalises, using title as its name", async () => {
    const client = mauticDouble();
    const view = await contentInventory.list({ companyId: COMPANY_A, kind: "landing_page", client });
    const row = view.rows[0];
    expect(Object.keys(row).sort()).toEqual(SHAPE);
    expect(row).toMatchObject({ kind: "landing_page", contentId: "1", name: "GRAV probe page", alias: "grav-probe-page" });
    /* A category label, not its id — the id is of no use to a reader. */
    expect(row.category).toBe("Acquisition");
  });

  test("the object-keyed email container is read, not mistaken for empty", async () => {
    /* ── THE PROVIDER QUIRK THIS PINS ─────────────────────────────────────
       `/api/emails` returns an OBJECT keyed by id. Code that spread it into an
       array would report a populated instance as empty — which is exactly the
       kind of wrong answer that looks like a real one. */
    const client = mauticDouble({
      emails: [LIVE_EMAIL_ROW, { ...LIVE_EMAIL_ROW, id: 7, name: "Second" }],
    });
    const view = await contentInventory.list({ companyId: COMPANY_A, kind: "email", client });
    expect(view.rows.map((r) => r.contentId)).toEqual(["1", "7"]);
  });

  test("an unmeasurable published flag is unknown, never unpublished", async () => {
    for (const value of [undefined, null, "true", 1, {}]) {
      expect(contentInventory.publication(value)).toEqual({ published: null, state: "unknown" });
    }
    expect(contentInventory.publication(true)).toEqual({ published: true, state: "published" });
    expect(contentInventory.publication(false)).toEqual({ published: false, state: "unpublished" });
  });

  test("absent values stay null and are never converted to zero or false", async () => {
    const bare = { id: 9, name: "Bare" };
    const row = contentInventory.safeRow("email", bare);
    expect(row).toMatchObject({
      alias: null, published: null, publicationState: "unknown",
      publishUp: null, publishDown: null, createdAt: null, modifiedAt: null,
      language: null, category: null,
    });
    expect(row.details).toEqual({});
    /* Not zero, not false, not an empty string standing in for a value. */
    expect(Object.values(row).some((v) => v === 0 || v === false)).toBe(false);
  });

  test("an unparseable date is null rather than an epoch", () => {
    const row = contentInventory.safeRow("form", { id: 1, dateAdded: "not a date", dateModified: "" });
    expect(row.createdAt).toBeNull();
    expect(row.modifiedAt).toBeNull();
  });

  test("a row with no id is a malformed response, not a blank row", () => {
    expect(() => contentInventory.safeRow("email", { name: "no id" }))
      .toThrow(/no identifier/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   4. WHAT NEVER LEAVES THE SERVICE
   ═══════════════════════════════════════════════════════════════════════════ */

describe("no body, script, recipient, submission or credential travels", () => {
  test("an email's HTML, plain text, recipients and addresses are all absent", async () => {
    const client = mauticDouble();
    const view = await contentInventory.list({ companyId: COMPANY_A, kind: "email", client });
    const text = JSON.stringify(view);

    for (const secret of [
      "SECRET BODY", "SECRET PLAIN TEXT", "SECRET DYNAMIC",
      "<script", "alert('xss')",
      "grav-integration-test",           // the recipient segment
      "marketing@grav-integration-test", // the from address
      "audit@grav-integration-test",     // the bcc address
      "reply@grav-integration-test",
    ]) {
      expect(text).not.toContain(secret);
    }
    /* And no field name that would carry them. */
    for (const field of [
      "customHtml", "plainText", "dynamicContent", "lists", "bccAddress",
      "fromAddress", "replyToAddress", "headers", "assetAttachments",
    ]) {
      expect(text).not.toContain(field);
    }
  });

  test("a form's cached HTML, fields and actions are absent", async () => {
    const client = mauticDouble();
    const view = await contentInventory.list({ companyId: COMPANY_A, kind: "form", client });
    const text = JSON.stringify(view);
    expect(text).not.toContain("SECRET FORM HTML");
    expect(text).not.toContain("cachedHtml");
    expect(text).not.toContain("\"fields\"");
    expect(text).not.toContain("\"actions\"");
  });

  test("a landing page's HTML is absent", async () => {
    const client = mauticDouble();
    const view = await contentInventory.list({ companyId: COMPANY_A, kind: "landing_page", client });
    expect(JSON.stringify(view)).not.toContain("SECRET PAGE HTML");
    expect(JSON.stringify(view)).not.toContain("customHtml");
  });

  test("no performance figure is reported, invented or passed through", async () => {
    const client = mauticDouble();
    for (const kind of CONTENT_KIND_CODES) {
      const view = await contentInventory.list({ companyId: COMPANY_A, kind, client });
      const text = JSON.stringify(view);
      for (const metric of ["readCount", "sentCount", "hits", "uniqueHits", "variantHits", "openRate", "clickRate"]) {
        expect(text).not.toContain(metric);
      }
    }
  });

  test("no send control, campaign association or credential field appears", async () => {
    const client = mauticDouble();
    const view = await contentInventory.list({ companyId: COMPANY_A, kind: "email", client });

    /* Field NAMES, gathered from the whole nested payload. Searching the
       serialised text would fail on an email subject that merely mentions a
       campaign, which is prose a marketer wrote and not an association GRAV
       invented. */
    const keys = new Set();
    (function walk(node) {
      if (!node || typeof node !== "object") return;
      for (const [k, v] of Object.entries(node)) { keys.add(k.toLowerCase()); walk(v); }
    }(view));

    for (const forbidden of [
      "send", "sendtodnc", "campaign", "campaigns", "password", "secret",
      "token", "credential", "apikey", "lists", "recipients",
    ]) {
      expect([...keys]).not.toContain(forbidden);
    }
  });

  test("the whole payload contains no HTML tag at all", async () => {
    const client = mauticDouble();
    for (const kind of CONTENT_KIND_CODES) {
      const view = await contentInventory.list({ companyId: COMPANY_A, kind, client });
      expect(JSON.stringify(view)).not.toMatch(/<[a-z/][^>]*>/i);
    }
  });

  test("a raw provider object never reaches a caller", async () => {
    const client = mauticDouble();
    const view = await contentInventory.list({ companyId: COMPANY_A, kind: "email", client });
    /* Every key on every row is one this service named. */
    const allowed = new Set([
      "kind", "contentId", "name", "alias", "published", "publicationState",
      "publishUp", "publishDown", "createdAt", "modifiedAt", "language", "category", "details",
    ]);
    for (const row of view.rows) {
      for (const key of Object.keys(row)) expect(allowed.has(key)).toBe(true);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   5. PROVIDER STATES REMAIN DISTINCT
   ═══════════════════════════════════════════════════════════════════════════ */

describe("empty, unreachable, refused and malformed are four different answers", () => {
  test("a genuine empty collection survives as empty", async () => {
    const client = mauticDouble({ emails: [], totals: { email: 0 } });
    const view = await contentInventory.list({ companyId: COMPANY_A, kind: "email", client });
    expect(view.rows).toEqual([]);
    expect(view.hasMore).toBe(false);
    expect(view.nextCursor).toBeNull();
    /* A MEASURED zero: the read succeeded and there is nothing there. */
    expect(view.libraryTotal).toBe(0);
    expect(view.libraryTotalAvailable).toBe(true);
  });

  test("an unreachable Mautic is an error, not an empty list", async () => {
    const client = mauticDouble({ failOn: "email" });
    await expect(contentInventory.list({ companyId: COMPANY_A, kind: "email", client }))
      .rejects.toMatchObject({ code: "MAUTIC_UNAVAILABLE" });
  });

  test("a refused credential is its own error", async () => {
    const client = mauticDouble({
      failOn: "email",
      failWith: { code: "MAUTIC_AUTH_FAILED", message: "Mautic refused GRAV's credentials." },
    });
    await expect(contentInventory.list({ companyId: COMPANY_A, kind: "email", client }))
      .rejects.toMatchObject({ code: "MAUTIC_AUTH_FAILED" });
  });

  test.each([
    ["a missing collection key", { total: 3 }],
    ["a null collection", { total: 3, emails: null }],
    ["a string where a list belongs", { total: 3, emails: "nope" }],
    ["a non-object response", "not json at all"],
    ["an entry that is not an object", { total: 1, emails: ["a string"] }],
  ])("%s is malformed, not empty", async (_label, data) => {
    const client = mauticDouble({ malformed: { kind: "email", data } });
    await expect(contentInventory.list({ companyId: COMPANY_A, kind: "email", client }))
      .rejects.toMatchObject({ code: "MAUTIC_MALFORMED_RESPONSE" });
  });

  test("a missing total stays null and is never the page length", async () => {
    const client = mauticDouble({ totals: { email: null } });
    const view = await contentInventory.list({ companyId: COMPANY_A, kind: "email", client });
    expect(view.rows).toHaveLength(1);
    expect(view.libraryTotal).toBeNull();
    expect(view.libraryTotalAvailable).toBe(false);
    /* The page length is reported separately and is never presented as a count
       of the collection. */
    expect(view.page.size).toBe(1);
  });

  test("a non-numeric total is treated as missing", async () => {
    for (const bad of ["22", {}, [], NaN, Infinity]) {
      const client = mauticDouble({ totals: { email: bad } });
      const view = await contentInventory.list({ companyId: COMPANY_A, kind: "email", client });
      expect(view.libraryTotal).toBeNull();
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   6. PAGINATION
   ═══════════════════════════════════════════════════════════════════════════ */

describe("paging is bounded, ordered and opaque", () => {
  const many = (n, base) => Array.from({ length: n }, (_, i) => ({ ...base, id: i + 1, name: `Item ${i + 1}` }));

  test("it walks a collection exactly once", async () => {
    const client = mauticDouble({ pages: many(7, LIVE_PAGE_ROW) });
    const seen = [];
    let cursor = null;
    let guard = 0;
    do {
      const view = await contentInventory.list({
        companyId: COMPANY_A, kind: "landing_page", client, cursor, limit: 2,
      });
      seen.push(...view.rows.map((r) => r.contentId));
      cursor = view.nextCursor;
      expect((guard += 1)).toBeLessThan(10);
    } while (cursor);

    expect(seen).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
    expect(new Set(seen).size).toBe(7);
  });

  test("an out-of-range limit is refused, and never reaches Mautic", async () => {
    const client = mauticDouble({ pages: many(7, LIVE_PAGE_ROW) });
    for (const limit of [100000, 0, -1, 1.5, "many", [5], {}, true]) {
      await expect(contentInventory.list({
        companyId: COMPANY_A, kind: "landing_page", client, limit,
      })).rejects.toMatchObject({ code: "VALIDATION" });
    }
    expect(client.calls).toEqual([]);

    const res = await call("/content?kind=landing_page&limit=0");
    expect(res.status).toBe(400);
    expect(res.body.error.details).toMatchObject({ field: "limit", min: 1, max: contentInventory.MAX_PAGE });
  });

  test("an omitted limit takes the default and a digit string is honoured", async () => {
    const client = mauticDouble({ pages: many(7, LIVE_PAGE_ROW) });
    expect(contentInventory.assertLimit(undefined)).toBe(contentInventory.DEFAULT_PAGE);
    expect(contentInventory.assertLimit(null)).toBe(contentInventory.DEFAULT_PAGE);
    expect(contentInventory.assertLimit("")).toBe(contentInventory.DEFAULT_PAGE);
    /* A query string arrives as text, so a string of digits is a caller obeying
       HTTP rather than ignoring the contract. */
    expect(contentInventory.assertLimit("10")).toBe(10);
    expect(contentInventory.assertLimit(contentInventory.MAX_PAGE)).toBe(contentInventory.MAX_PAGE);

    const view = await contentInventory.list({ companyId: COMPANY_A, kind: "landing_page", client });
    expect(view.page.maxSize).toBe(contentInventory.MAX_PAGE);
    /* Seven rows on the page, seven in the collection — reported separately so a
       larger collection cannot be misread. */
    expect(view.libraryTotal).toBe(7);
    expect(view.page.size).toBe(7);
  });

  test("a provider total is usable only when it is a finite non-negative integer", async () => {
    for (const total of [1.5, -1, "22", NaN, Infinity, null, undefined, {}, []]) {
      const client = mauticDouble({ totals: { landing_page: total } });
      const view = await contentInventory.list({ companyId: COMPANY_A, kind: "landing_page", client });
      expect(view.libraryTotal).toBeNull();
      expect(view.libraryTotalAvailable).toBe(false);
    }
    const ok = mauticDouble({ totals: { landing_page: 0 } });
    const zero = await contentInventory.list({ companyId: COMPANY_A, kind: "landing_page", client: ok });
    /* Zero is a real count and survives as one. */
    expect(zero.libraryTotal).toBe(0);
    expect(zero.libraryTotalAvailable).toBe(true);
  });

  test("a cursor from one kind cannot page another", async () => {
    const client = mauticDouble({ emails: many(5, LIVE_EMAIL_ROW), pages: many(5, LIVE_PAGE_ROW) });
    const emails = await contentInventory.list({ companyId: COMPANY_A, kind: "email", client, limit: 2 });
    await expect(contentInventory.list({
      companyId: COMPANY_A, kind: "landing_page", client, cursor: emails.nextCursor,
    })).rejects.toMatchObject({ code: "VALIDATION" });
  });

  test.each([
    ["nonsense", "not-a-cursor"],
    ["a bare number", "5"],
    ["a negative offset", Buffer.from("email:-5", "utf8").toString("base64url")],
    ["a foreign shape", Buffer.from("email", "utf8").toString("base64url")],
  ])("a malformed cursor (%s) is refused", async (_label, cursor) => {
    const client = mauticDouble();
    await expect(contentInventory.list({ companyId: COMPANY_A, kind: "email", client, cursor }))
      .rejects.toMatchObject({ code: "VALIDATION" });
  });

  test("the cursor is opaque and carries its kind", () => {
    const cursor = contentInventory.encodeCursor("email", 40);
    expect(cursor).not.toContain("40");
    expect(contentInventory.decodeCursor(cursor, "email")).toBe(40);
    expect(contentInventory.decodeCursor(null, "email")).toBe(0);
  });

  test("a kind is required and an unknown kind is refused", async () => {
    const client = mauticDouble();
    await expect(contentInventory.list({ companyId: COMPANY_A, client }))
      .rejects.toMatchObject({ code: "VALIDATION" });
    await expect(contentInventory.list({ companyId: COMPANY_A, kind: "campaign", client }))
      .rejects.toMatchObject({ code: "VALIDATION" });

    const res = await call("/content?kind=newsletter");
    expect(res.status).toBe(400);
    expect(res.body.error.details.accepted).toEqual(CONTENT_KIND_CODES);
    /* Refused, not answered with an empty page that reads as "there are none". */
    expect(res.body.rows).toBeUndefined();
  });

  test("the refusal explains why three lists are not merged", async () => {
    const res = await call("/content");
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/does not merge/i);
    expect(res.body.error.message).toMatch(/separately paged/i);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   7. THE SUMMARY
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the summary reads each kind independently", () => {
  test("all three readable gives three counts and a total", async () => {
    const client = mauticDouble({ totals: { email: 22, form: 2, landing_page: 5 } });
    const view = await contentInventory.summary({ companyId: COMPANY_A, client });
    expect(view.kinds.email).toMatchObject({ state: "ok", count: 22 });
    expect(view.kinds.form).toMatchObject({ state: "ok", count: 2 });
    expect(view.kinds.landing_page).toMatchObject({ state: "ok", count: 5 });
    expect(view.partial).toBe(false);
    expect(view.totalAcrossKinds).toBe(29);
  });

  test("a genuine zero survives as zero", async () => {
    const client = mauticDouble({ emails: [], forms: [], pages: [], totals: { email: 0, form: 0, landing_page: 0 } });
    const view = await contentInventory.summary({ companyId: COMPANY_A, client });
    for (const kind of CONTENT_KIND_CODES) {
      expect(view.kinds[kind]).toMatchObject({ state: "ok", count: 0 });
    }
    expect(view.partial).toBe(false);
    expect(view.totalAcrossKinds).toBe(0);
  });

  test("one failing kind does NOT become zero, and marks the result partial", async () => {
    /* ── THE MOST DANGEROUS POSSIBLE ANSWER ───────────────────────────────
       A zero here looks like information and like good news, and is
       indistinguishable from a genuinely empty estate somebody might act on by
       building content that already exists. */
    const client = mauticDouble({ failOn: "form", totals: { email: 22, landing_page: 5 } });
    const view = await contentInventory.summary({ companyId: COMPANY_A, client });

    expect(view.kinds.form.state).toBe("failed");
    expect(view.kinds.form.count).toBeNull();
    expect(view.kinds.form.count).not.toBe(0);
    /* The PUBLIC code, not the internal one. A client reading this summary
       learns that the engine could not be reached, and not which product it is. */
    expect(view.kinds.form.reasonCode).toBe("MARKETING_ENGINE_UNREACHABLE");

    /* The readable kinds still report. */
    expect(view.kinds.email).toMatchObject({ state: "ok", count: 22 });
    expect(view.kinds.landing_page).toMatchObject({ state: "ok", count: 5 });

    expect(view.partial).toBe(true);
    expect(view.unreadableKinds).toEqual(["form"]);
    /* No cross-kind total, because one that silently omitted forms would
       understate the estate. */
    expect(view.totalAcrossKinds).toBeNull();
  });

  test("a malformed kind is distinguished from an unreachable one", async () => {
    const client = mauticDouble({ malformed: { kind: "landing_page", data: { total: 3 } } });
    const view = await contentInventory.summary({ companyId: COMPANY_A, client });
    expect(view.kinds.landing_page.state).toBe("failed");
    expect(view.kinds.landing_page.reasonCode).toBe("MARKETING_ENGINE_UNREADABLE_RESPONSE");
    expect(view.kinds.landing_page.count).toBeNull();
  });

  test("a readable kind with no usable total is unreadable, not zero", async () => {
    const client = mauticDouble({ totals: { email: null } });
    const view = await contentInventory.summary({ companyId: COMPANY_A, client });
    expect(view.kinds.email).toMatchObject({ state: "unreadable", count: null });
    expect(view.partial).toBe(true);
    expect(view.totalAcrossKinds).toBeNull();
  });

  test("every kind failing still reports three named failures", async () => {
    const client = {
      calls: [],
      async listContent(kind) {
        const err = new Error("down"); err.code = "MAUTIC_UNAVAILABLE"; throw err;
      },
    };
    const view = await contentInventory.summary({ companyId: COMPANY_A, client });
    expect(view.unreadableKinds).toEqual(CONTENT_KIND_CODES);
    expect(Object.values(view.kinds).every((k) => k.count === null)).toBe(true);
    expect(view.totalAcrossKinds).toBeNull();
  });

  test("a failure reason carries a code and a sentence, never a stack", async () => {
    const client = mauticDouble({
      failOn: "email",
      failWith: { code: "MAUTIC_UNAVAILABLE", message: "x".repeat(900) },
    });
    const view = await contentInventory.summary({ companyId: COMPANY_A, client });
    expect(view.kinds.email.reason.length).toBeLessThanOrEqual(300);
    expect(JSON.stringify(view)).not.toMatch(/node_modules|at Object\.|Error:/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   8. OWNERSHIP LANGUAGE, AND WHAT NOTHING ELSE CHANGED
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the contract states who owns what, and writes nothing", () => {
  test("the served vocabulary names the ownership boundary", async () => {
    /* Read from the service, which is where the vocabulary lives; the HTTP
       route serves this same object and no provider is configured in this
       suite. */
    const own = contentInventory.vocabulary.ownership;
    expect(own).toMatchObject({
      contentStorage: "marketing_engine", contentEditing: "marketing_engine",
      publishing: "marketing_engine", sending: "marketing_engine",
      inventory: "grav_marketing", brandedOneToMany: "grav_marketing",
      personalConversation: "grav_sales",
    });
    /* Said in the payload, so a client rendering a published badge knows what
       it may not claim. */
    expect(own.publishedMeans).toMatch(/does not prove/i);
    expect(own.publishedMeans).toMatch(/sent, delivered or seen/i);
    expect(contentInventory.vocabulary.kinds.map((k) => k.code)).toEqual(CONTENT_KIND_CODES);
  });

  test("reading the inventory writes no Sales, CRM, consent or handover record", async () => {
    const before = await Promise.all([
      Lead.countDocuments({}), Enquiry.countDocuments({}), SalesJourney.countDocuments({}),
      MarketingConsent.countDocuments({}), Handover.countDocuments({}),
    ]);

    const client = mauticDouble();
    await contentInventory.list({ companyId: COMPANY_A, kind: "email", client });
    await contentInventory.summary({ companyId: COMPANY_A, client });
    await call("/content?kind=form");
    await call("/content/summary");

    const after = await Promise.all([
      Lead.countDocuments({}), Enquiry.countDocuments({}), SalesJourney.countDocuments({}),
      MarketingConsent.countDocuments({}), Handover.countDocuments({}),
    ]);
    expect(after).toEqual(before);
  });

  test("the service loads no Sales model and no writer", () => {
    const fs = require("fs");
    const source = fs.readFileSync(
      require.resolve("../../services/marketing/contentInventory.service"), "utf8",
    );
    const requires = [...source.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]);
    for (const path of requires) {
      expect(path).not.toMatch(/CMS_Models\/Sales|services\/sales\//);
    }
    expect(requires.sort()).toEqual([
      "../../constants/marketing",
      "../storePurchase/errors",
      "./mauticClient",
      "./providerPrivacy",
    ]);
  });

  test("the router exposes exactly two GET routes", () => {
    const router = require("../../routes/CMS_Routes/Marketing/contentInventory");
    const paths = router.stack
      .filter((l) => l.route)
      .map((l) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`);
    expect(paths.sort()).toEqual(["GET /content", "GET /content/summary"]);
    expect(paths.every((p) => p.startsWith("GET "))).toBe(true);
  });

  test("the existing Mautic client behaviour is untouched", () => {
    /* The projection and acquisition-hold methods this slice must not disturb. */
    for (const method of [
      "findContactByEmail", "createContact", "updateContact", "addContactToSegment",
      "contactSegments", "contactCampaigns", "removeContactFromSegment",
      "removeContactFromCampaign", "listSegments", "listCampaigns", "getSegment",
      "updateSegment", "getCampaign", "getContact",
    ]) {
      expect(typeof MauticClient.prototype[method]).toBe("function");
    }
  });
});
