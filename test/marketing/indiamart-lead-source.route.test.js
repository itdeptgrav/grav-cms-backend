// test/marketing/indiamart-lead-source.route.test.js
//
// INDIAMART AS A LEAD SOURCE: A BOUNDED, IDEMPOTENT PULL INTO THE ENQUIRIES
// INBOX, OVER THE REAL ROUTES.
//
// ── WHAT THIS PINS ─────────────────────────────────────────────────────────
//   Windows: 7 days at most, a 15-minute overlap, never before 365 days, and
//   the cursor moves only after every record in the window is saved.
//   A repeated window, a retried check and a lost response never duplicate.
//   One call per check, at least 5 minutes apart, 15 after a 429.
//   Buyer enquiries are told apart from purchased leads and catalog views.
//   The pull processes nothing and records no permission; routing to Sales is
//   pinned separately in indiamart-sales-routing.test.js.
//   The key, the URL and IndiaMART's ids and messages never leave the server.
//   Another company sees nothing, and cannot use the key.
//   No test reaches IndiaMART: the transport is injected.
"use strict";

jest.mock("../../Middlewear/MarketingAuthMiddlewear", () => {
  const mw = (req, res, next) => {
    const raw = req.headers["x-test-user"];
    if (!raw) return res.status(401).json({ success: false, message: "Authentication required." });
    const user = JSON.parse(raw);
    if (!["marketing", "admin", "ceo"].includes(user.role) && !user.isAdmin) {
      return res.status(403).json({ success: false, message: "Access denied." });
    }
    req.user = user;
    return next();
  };
  mw.ALLOWED_ROLES = ["marketing", "admin", "ceo"];
  return mw;
});

const express = require("express");
const mongoose = require("mongoose");

const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const { MarketingSourceEnquiry } = require("../../models/CMS_Models/Marketing/MarketingSourceEnquiry");
const { MarketingLeadSourceState } = require("../../models/CMS_Models/Marketing/MarketingLeadSourceState");
const { MarketingLeadProcessingReceipt } = require("../../models/CMS_Models/Marketing/MarketingLeadProcessingReceipt");
const MarketingIdentity = require("../../models/CMS_Models/Marketing/MarketingIdentity");
const { MarketingIntentEvent } = require("../../models/CMS_Models/Marketing/MarketingEvent");
const { MarketingConsent } = require("../../models/CMS_Models/Marketing/MarketingConsent");
const ProspectHandover = require("../../models/CMS_Models/Marketing/ProspectHandover");
const Lead = require("../../models/CMS_Models/Sales/Lead");
const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");

const client = require("../../services/marketing/leads/indiamartClient");
const sync = require("../../services/marketing/leads/indiamartSync.service");
const access = require("../../services/marketing/marketingAccess");
const I = require("../../constants/marketingIndiamart");

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const KEY = "mRyxEb1u4XzGTUNkSECRETKEYvalue";
const NOW = Date.parse("2026-09-22T06:30:00.000Z"); // 12:00:00 IST

const MARKETER = { id: new mongoose.Types.ObjectId().toString(), name: "Mo", role: "marketing" };
const ADMIN = { id: new mongoose.Types.ObjectId().toString(), name: "Ada", role: "admin" };
const CEO = { id: new mongoose.Types.ObjectId().toString(), name: "Cy", role: "ceo" };

let A; let B;
let app; let server; let base;
const clock = { now: NOW };
const ENV_KEYS = ["MARKETING_COMPANY_ID", I.KEY_ENV];
const saved = {};

/* ── A FAKE INDIAMART ──────────────────────────────────────────────────── */
let answers = [];
let calls = [];
function transport(url) {
  const u = new URL(url);
  calls.push({
    host: u.host,
    path: u.pathname,
    key: u.searchParams.get("glusr_crm_key"),
    start: u.searchParams.get("start_time"),
    end: u.searchParams.get("end_time"),
  });
  const next = answers.shift();
  if (!next) return Promise.reject(new Error(`no answer queued for ${url}`));
  if (typeof next === "function") return next(url);
  if (next instanceof Error) return Promise.reject(next);
  return Promise.resolve(next);
}
const ok = (records, extra = {}) => ({
  status: 200,
  text: JSON.stringify({ CODE: 200, STATUS: "SUCCESS", MESSAGE: "", TOTAL_RECORDS: records.length, RESPONSE: records, ...extra }),
});
const code = (c, message) => ({
  status: 200,
  text: JSON.stringify({ CODE: c, STATUS: "FAILURE", MESSAGE: message, TOTAL_RECORDS: 0, RESPONSE: [] }),
});

let seq = 0;
const rec = (over = {}) => ({
  UNIQUE_QUERY_ID: over.UNIQUE_QUERY_ID || `2${String(98765430 + (seq += 1))}`,
  QUERY_TYPE: "W",
  QUERY_TIME: "2026-09-20 10:15:00",
  SENDER_NAME: "Ravi Kumar",
  SENDER_MOBILE: "+91-9812345678",
  SENDER_EMAIL: "ravi@kumartextiles.in",
  SENDER_COMPANY: "Kumar Textiles",
  SENDER_CITY: "Tiruppur",
  SENDER_STATE: "Tamil Nadu",
  SENDER_COUNTRY_ISO: "IN",
  SUBJECT: "Requirement for Cotton T-shirts",
  QUERY_PRODUCT_NAME: "Cotton T-shirts",
  QUERY_MCAT_NAME: "Men's T-Shirts",
  QUERY_MESSAGE: "Need 500 pcs, round neck.",
  ...over,
});

/* ── HTTP ──────────────────────────────────────────────────────────────── */
async function call(method, path, { user = ADMIN, company = A, body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (user) headers["x-test-user"] = JSON.stringify(user);
  if (company) headers["x-test-company"] = String(company);
  const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { json = null; }
  return { status: res.status, body: json, text };
}
const status = (opts) => call("GET", "/lead-sources/indiamart", opts);
const checkNow = (opts) => call("POST", "/lead-sources/indiamart/check", opts);
const inbox = (qs = "", opts) => call("GET", `/enquiries${qs ? `?${qs}` : ""}`, { user: MARKETER, ...opts });
const later = (ms) => { clock.now += ms; };

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const c = String(req.headers["x-test-company"] || "");
    if (mongoose.Types.ObjectId.isValid(c)) req.__marketingCompanyId = new mongoose.Types.ObjectId(c);
    next();
  });
  app.locals.marketingIndiamartTransport = transport;
  app.locals.marketingIndiamartClock = () => clock.now;
  app.use("/api/cms/marketing", require("../../routes/CMS_Routes/Marketing/enquiries"));
  app.use("/api/cms/marketing", require("../../routes/CMS_Routes/Marketing/leadSources"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/marketing`;
});
afterAll(async () => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await new Promise((r) => server.close(r));
});

beforeEach(async () => {
  A = (await Acc_Company.create({ companyName: "GRAV Clothing", booksFromDate: new Date("2026-04-01") }))._id;
  B = (await Acc_Company.create({ companyName: "Other Co", booksFromDate: new Date("2026-04-01") }))._id;
  process.env.MARKETING_COMPANY_ID = String(A);
  process.env[I.KEY_ENV] = KEY;
  clock.now = NOW;
  answers = [];
  calls = [];
  jest.restoreAllMocks();
});

const stateOf = (company = A) => MarketingLeadSourceState.findOne({ companyId: company, source: "indiamart" }).lean();

/* ═══ 1. NOT CONNECTED ════════════════════════════════════════════════════ */

describe("not connected", () => {
  test("1. no key: status says so, Check now is refused, IndiaMART is not called", async () => {
    delete process.env[I.KEY_ENV];
    const s = await status({ user: MARKETER });
    expect(s.status).toBe(200);
    expect(s.body.indiamart.configured).toBe(false);
    expect(s.body.indiamart.connection.code).toBe("not_configured");
    expect(s.body.indiamart.lastCheck).toBeNull();
    expect(s.body.indiamart.lastError).toBeNull();
    expect(s.body.indiamart.enquiries.total).toBe(0);
    expect(s.body.indiamart.automaticChecks.enabled).toBe(false);

    const admin = await status();
    expect(admin.body.indiamart.checkNow).toMatchObject({ allowed: false, blockedBy: { code: "not_configured" } });

    const c = await checkNow();
    expect(c.status).toBe(409);
    expect(c.body.error.code).toBe("LEAD_SOURCE_NOT_CONFIGURED");
    expect(calls).toHaveLength(0);
    expect(await MarketingLeadSourceState.countDocuments({})).toBe(0);
  });

  test("2. a key without the Marketing company, or a malformed key, is not a connection", async () => {
    delete process.env.MARKETING_COMPANY_ID;
    expect((await status()).body.indiamart.connection.code).toBe("not_configured");
    expect((await checkNow()).status).toBe(409);

    process.env.MARKETING_COMPANY_ID = String(A);
    process.env[I.KEY_ENV] = "has a space";
    expect((await status()).body.indiamart.connection.code).toBe("not_configured");
    expect(calls).toHaveLength(0);
  });

  test("3. a key is present but unchecked: configured_unverified, and Check now is offered to an administrator only", async () => {
    const admin = (await status()).body.indiamart;
    expect(admin.connection.code).toBe("configured_unverified");
    expect(admin.checkNow).toEqual({ allowed: true, blockedBy: null, running: false, nextAllowedAt: null });
    const marketer = (await status({ user: MARKETER })).body.indiamart;
    expect(marketer.checkNow.allowed).toBe(false);
    expect(marketer.checkNow.blockedBy.code).toBe("not_administrator");
  });
});

/* ═══ 2. THE WINDOW ═══════════════════════════════════════════════════════ */

describe("windows", () => {
  test("4. the first check asks for the last 7 days (less a minute) in IndiaMART's IST format, once", async () => {
    answers.push(ok([rec()]));
    const c = await checkNow();
    expect(c.status).toBe(200);
    expect(c.body.success).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      host: "mapi.indiamart.com",
      path: "/wservce/crm/crmListing/v2/",
      key: KEY,
      start: client.formatIst(new Date(NOW - I.LIMITS.MAX_WINDOW_MS)),
      end: "22-Sep-202612:00:00",
    });
    expect(calls[0].start).toBe("15-Sep-202612:01:00");
    expect(c.body.check.window).toEqual({
      from: new Date(NOW - 7 * DAY + MINUTE).toISOString(),
      to: new Date(NOW).toISOString(),
    });
    expect(c.body.check.reachedNow).toBe(true);
    const st = await stateOf();
    expect(st.coveredThrough.getTime()).toBe(NOW);
    expect(st.coveredFrom.getTime()).toBe(NOW - 7 * DAY + MINUTE);
  });

  test("5. the next check starts 15 minutes before the last one ended", async () => {
    answers.push(ok([]), ok([]));
    await checkNow();
    later(5 * MINUTE);
    const c = await checkNow();
    expect(c.status).toBe(200);
    expect(c.body.check.window).toEqual({
      from: new Date(NOW - 15 * MINUTE).toISOString(),
      to: new Date(NOW + 5 * MINUTE).toISOString(),
    });
    expect(calls[1].start).toBe("22-Sep-202611:45:00");
    expect(calls[1].end).toBe("22-Sep-202612:05:00");
  });

  test("6. far behind: each check covers at most 7 days and says it is still catching up", async () => {
    await MarketingLeadSourceState.create({
      companyId: A, source: "indiamart", coveredFrom: new Date(NOW - 40 * DAY), coveredThrough: new Date(NOW - 20 * DAY),
    });
    answers.push(ok([]), ok([]));
    const first = await checkNow();
    const from = NOW - 20 * DAY - 15 * MINUTE;
    expect(first.body.check.window).toEqual({
      from: new Date(from).toISOString(),
      to: new Date(from + 7 * DAY - MINUTE).toISOString(),
    });
    expect(first.body.check.reachedNow).toBe(false);
    expect(first.body.indiamart.coverage.catchingUp).toBe(true);
    expect(first.body.indiamart.coverage.coveredFrom).toBe(new Date(NOW - 40 * DAY).toISOString());

    later(5 * MINUTE);
    const second = await checkNow();
    const w = second.body.check.window;
    expect(Date.parse(w.to) - Date.parse(w.from)).toBe(7 * DAY - MINUTE);
    expect(Date.parse(w.from)).toBe(from + 7 * DAY - MINUTE - 15 * MINUTE);
  });

  test("7. never before IndiaMART's 365 days; the range that aged out is recorded as a gap", async () => {
    const lost = new Date(NOW - 400 * DAY);
    await MarketingLeadSourceState.create({ companyId: A, source: "indiamart", coveredFrom: lost, coveredThrough: lost });
    answers.push(ok([]));
    const c = await checkNow();
    const floor = NOW - 365 * DAY + 60 * MINUTE;
    expect(c.body.check.window.from).toBe(new Date(floor).toISOString());
    expect(c.body.indiamart.coverage.gaps).toEqual([{ from: lost.toISOString(), to: new Date(floor).toISOString() }]);
    /* Unbroken coverage restarts after the gap; it never begins inside one. */
    expect(c.body.indiamart.coverage.coveredFrom).toBe(new Date(floor).toISOString());
    expect(c.body.indiamart.coverage.retentionDays).toBe(365);
  });

  test("8. window arithmetic, directly", () => {
    const { nextWindow } = sync.__internals;
    const w0 = nextWindow(null, NOW + 999);
    expect(w0.to.getTime()).toBe(NOW); // whole seconds only
    expect(w0.to - w0.from).toBe(7 * DAY - MINUTE);
    const recent = nextWindow({ coveredThrough: new Date(NOW - 2 * MINUTE) }, NOW);
    expect([recent.from.getTime(), recent.to.getTime()]).toEqual([NOW - 17 * MINUTE, NOW]);
    expect(recent.gap).toBeNull();
    /* A cursor ahead of now (clock skew) never asks for the future. */
    const ahead = nextWindow({ coveredThrough: new Date(NOW + 60 * MINUTE) }, NOW);
    expect(ahead.to.getTime()).toBe(NOW);
  });
});

/* ═══ 3. DUPLICATES, RETRIES, LOST RESPONSES ══════════════════════════════ */

describe("idempotency", () => {
  test("9. an overlapping window returns the same enquiries: none is stored twice", async () => {
    const r1 = rec(); const r2 = rec();
    answers.push(ok([r1, r2]), ok([r1, r2, rec()]));
    const first = await checkNow();
    expect(first.body.check.counts).toEqual({ received: 2, recorded: 2, alreadyHeld: 0, unreadable: 0 });
    later(5 * MINUTE);
    const second = await checkNow();
    expect(second.body.check.counts).toEqual({ received: 3, recorded: 1, alreadyHeld: 2, unreadable: 0 });
    expect(await MarketingSourceEnquiry.countDocuments({ companyId: A })).toBe(3);
    expect((await inbox()).body.page.total).toBe(3);
  });

  test("10. the same enquiry twice in one answer is stored once", async () => {
    const r = rec();
    answers.push(ok([r, { ...r }]));
    const c = await checkNow();
    expect(c.body.check.counts).toEqual({ received: 2, recorded: 1, alreadyHeld: 1, unreadable: 0 });
  });

  test("11. a lost answer from IndiaMART: failed, cursor unmoved, the same window is fetched again without duplicates", async () => {
    const r = rec();
    answers.push(new Error(`socket hang up https://mapi.indiamart.com/?glusr_crm_key=${KEY}`));
    const lost = await checkNow();
    expect(lost.status).toBe(200);
    expect(lost.body.success).toBe(false);
    expect(lost.body.check.outcome).toBe("failed");
    expect(lost.body.check.error).toMatchObject({ code: "unreachable", retryable: true });
    expect(lost.text).not.toContain(KEY);
    expect(lost.text).not.toContain("socket hang up");
    expect((await stateOf()).coveredThrough).toBeNull();

    /* The lost call still counted against IndiaMART's limit. */
    expect((await checkNow()).status).toBe(429);

    later(5 * MINUTE);
    answers.push(ok([r]));
    const retry = await checkNow();
    expect(retry.body.check.window.from).toBe(new Date(NOW + 5 * MINUTE - 7 * DAY + MINUTE).toISOString());
    expect(retry.body.check.counts.recorded).toBe(1);
    expect(retry.body.indiamart.connection.code).toBe("connected");
  });

  test("12. a lost answer to GRAV's caller: repeating the check refetches and records nothing new", async () => {
    const r1 = rec(); const r2 = rec();
    answers.push(ok([r1, r2]));
    await checkNow(); // the browser never saw this
    expect((await checkNow()).status).toBe(429);
    later(5 * MINUTE);
    answers.push(ok([r1, r2]));
    const again = await checkNow();
    expect(again.body.check.counts).toMatchObject({ recorded: 0, alreadyHeld: 2 });
    expect(await MarketingSourceEnquiry.countDocuments({})).toBe(2);
  });

  test("13. a partial save: saved enquiries stay, the cursor does not move, the retry completes without duplicates", async () => {
    const recs = [rec(), rec(), rec(), rec()];
    const real = MarketingSourceEnquiry.create.bind(MarketingSourceEnquiry);
    let n = 0;
    const spy = jest.spyOn(MarketingSourceEnquiry, "create").mockImplementation((doc) => {
      n += 1;
      if (n === 3) return Promise.reject(Object.assign(new Error("connection reset by peer"), { name: "MongoNetworkError" }));
      return real(doc);
    });
    answers.push(ok(recs));
    const partial = await checkNow();
    expect(partial.body.check.outcome).toBe("failed");
    expect(partial.body.check.error.code).toBe("storage_failed");
    expect(partial.body.check.counts).toMatchObject({ received: 4, recorded: 2 });
    expect(partial.text).not.toContain("connection reset");
    expect(await MarketingSourceEnquiry.countDocuments({})).toBe(2);
    const st = await stateOf();
    expect(st.coveredThrough).toBeNull();
    expect(st.consecutiveFailures).toBe(1);
    const s = (await status({ user: MARKETER })).body.indiamart;
    expect(s.connection.code).toBe("failing");
    expect(s.lastError).toMatchObject({ code: "storage_failed", retryable: true });
    expect(s.lastError.action).toMatch(/nothing will be duplicated/i);

    spy.mockRestore();
    later(5 * MINUTE);
    answers.push(ok(recs));
    const retry = await checkNow();
    expect(retry.body.check.counts).toEqual({ received: 4, recorded: 2, alreadyHeld: 2, unreadable: 0 });
    expect(Date.parse(retry.body.check.window.from)).toBe(NOW - 7 * DAY + MINUTE + 5 * MINUTE);
    expect(await MarketingSourceEnquiry.countDocuments({})).toBe(4);
    expect((await stateOf()).consecutiveFailures).toBe(0);
  });

  test("14. an answer that says it holds more than it sent does not cover the window, and stores nothing", async () => {
    answers.push(ok([rec(), rec()], { TOTAL_RECORDS: 5 }));
    const c = await checkNow();
    expect(c.body.check.error.code).toBe("incomplete_response");
    expect(await MarketingSourceEnquiry.countDocuments({})).toBe(0);
    expect((await stateOf()).coveredThrough).toBeNull();
  });

  test("15. a record with no usable id is counted as unreadable; the rest are saved and the window is covered", async () => {
    answers.push(ok([rec(), { ...rec(), UNIQUE_QUERY_ID: "" }, { ...rec(), UNIQUE_QUERY_ID: "has spaces" }, "junk"]));
    const c = await checkNow();
    expect(c.body.check.outcome).toBe("completed");
    expect(c.body.check.counts).toEqual({ received: 4, recorded: 1, alreadyHeld: 0, unreadable: 3 });
    expect((await stateOf()).coveredThrough.getTime()).toBe(NOW);
  });

  test("16. two checks at once: one runs, the other is refused, IndiaMART is called once", async () => {
    let release;
    answers.push(() => new Promise((r) => { release = () => r(ok([rec()])); }));
    const first = checkNow();
    await new Promise((r) => setTimeout(r, 150));
    const second = await checkNow();
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("LEAD_SOURCE_CHECK_IN_PROGRESS");
    const running = (await status()).body.indiamart.checkNow;
    expect(running).toMatchObject({ allowed: false, running: true, blockedBy: { code: "running" } });
    release();
    expect((await first).status).toBe(200);
    expect(calls).toHaveLength(1);
    const st = await stateOf();
    expect([st.leaseUntil, st.leaseToken]).toEqual([null, ""]);
  });

  test("17. a crashed check's lease expires and frees the source", async () => {
    await MarketingLeadSourceState.create({
      companyId: A, source: "indiamart", leaseUntil: new Date(NOW - 1000), leaseToken: "dead", lastCallAt: new Date(NOW - 10 * MINUTE),
    });
    answers.push(ok([]));
    expect((await checkNow()).status).toBe(200);
  });
});

/* ═══ 4. INDIAMART'S ANSWERS ══════════════════════════════════════════════ */

describe("IndiaMART's codes", () => {
  test("18. 204 is a genuine empty window: completed, zero, and the window is covered", async () => {
    answers.push(code(204, "There are no leads in the given time duration.please try for a different duration."));
    const c = await checkNow();
    expect(c.body.check).toMatchObject({ outcome: "completed", counts: { received: 0, recorded: 0 } });
    expect(c.body.indiamart.connection.code).toBe("connected");
    expect((await stateOf()).coveredThrough.getTime()).toBe(NOW);
  });

  test("19. 429: rate limited, and GRAV waits 15 minutes, not 5", async () => {
    answers.push(code(429, "It is advised to hit this API once in every 5 minutes"));
    const c = await checkNow();
    expect(c.body.check.error).toMatchObject({ code: "rate_limited", retryable: true });
    expect(c.body.indiamart.checkNow.nextAllowedAt).toBe(new Date(NOW + 15 * MINUTE).toISOString());
    later(5 * MINUTE);
    const soon = await checkNow();
    expect(soon.status).toBe(429);
    expect(soon.body.error.code).toBe("LEAD_SOURCE_CHECK_TOO_SOON");
    expect(soon.body.error.details.nextAllowedAt).toBe(new Date(NOW + 15 * MINUTE).toISOString());
    later(10 * MINUTE);
    answers.push(ok([]));
    expect((await checkNow()).status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  test("20. 401: the key is refused, with what to do and where — and IndiaMART's own words are not repeated", async () => {
    answers.push(code(401, "Pull API Key that you are using is incorrect or has been expired."));
    const c = await checkNow();
    expect(c.body.check.error).toMatchObject({ code: "key_rejected", retryable: false });
    expect(c.body.check.error.action).toContain(I.KEY_PAGE);
    expect(c.text).not.toMatch(/Pull API Key that you are using/);
    const s = (await status({ user: MARKETER })).body.indiamart;
    expect(s.connection.code).toBe("failing");
    expect(s.lastError.code).toBe("key_rejected");
    expect(s.coverage.coveredThrough).toBeNull();
  });

  test("21. 400, 500, an HTML page and an unknown code are each named, and none covers the window", async () => {
    const cases = [
      [code(400, "You can fetch the data for the last 365 days only."), "window_rejected"],
      [code(500, "Some Error Occured"), "provider_error"],
      [{ status: 502, text: "<html>Bad Gateway</html>" }, "provider_error"],
      [{ status: 200, text: "<html>maintenance</html>" }, "malformed_response"],
      [code(418, "?"), "malformed_response"],
      [{ status: 200, text: JSON.stringify({ CODE: 200, STATUS: "SUCCESS", RESPONSE: "nope" }) }, "malformed_response"],
    ];
    for (const [answer, expected] of cases) {
      answers.push(answer);
      const c = await checkNow();
      expect([expected, c.body.check.error.code]).toEqual([expected, expected]);
      later(5 * MINUTE);
    }
    expect((await stateOf()).coveredThrough).toBeNull();
    expect((await stateOf()).consecutiveFailures).toBe(cases.length);
  });

  test("22. the client reads IndiaMART's answers directly", () => {
    expect(client.interpret(ok([rec()])).records).toHaveLength(1);
    expect(client.interpret(code(204, "none"))).toEqual({ records: [], empty: true });
    expect(client.interpret({ status: 200, text: JSON.stringify({ CODE: "200", STATUS: "SUCCESS", RESPONSE: [] }) }).empty).toBe(true);
    expect(() => client.interpret({ status: 401, text: "" })).toThrow(expect.objectContaining({ code: "key_rejected" }));
    expect(() => client.interpret({ status: 429, text: "" })).toThrow(expect.objectContaining({ code: "rate_limited" }));
    expect(client.formatIst(new Date("2021-12-07T03:30:00Z"))).toBe("07-Dec-202109:00:00");
    expect(client.parseIst("2026-09-20 10:15:00").toISOString()).toBe("2026-09-20T04:45:00.000Z");
    expect(client.parseIst("2026-02-31 10:15:00")).toBeNull();
    expect(client.parseIst("20-Sep-2026 10:15")).toBeNull();
  });
});

/* ═══ 5. THE INBOX ════════════════════════════════════════════════════════ */

describe("inbox", () => {
  test("23. buyer enquiries are told apart from purchased leads and catalog views", async () => {
    answers.push(ok([
      rec({ QUERY_TYPE: "W" }), rec({ QUERY_TYPE: "P", CALL_DURATION: "95" }), rec({ QUERY_TYPE: "WA" }),
      rec({ QUERY_TYPE: "B" }), rec({ QUERY_TYPE: "BIZ" }), rec({ QUERY_TYPE: "ZZ" }),
    ]));
    const c = await checkNow();
    expect(c.body.indiamart.enquiries.byKind).toEqual([
      { code: "buyer_enquiry", label: "Buyer enquiry", isEnquiry: true, count: 3 },
      { code: "purchased_lead", label: "Purchased lead", isEnquiry: false, count: 1 },
      { code: "catalog_view", label: "Catalog view", isEnquiry: false, count: 1 },
      { code: "unclassified", label: "Unrecognised type", isEnquiry: false, count: 1 },
    ]);
    const kinds = async (qs) => (await inbox(qs)).body.enquiries.map((e) => e.kind).sort();
    expect(await kinds("kind=buyer_enquiry")).toEqual(["buyer_enquiry", "buyer_enquiry", "buyer_enquiry"]);
    expect(await kinds("kind=purchased_lead")).toEqual(["purchased_lead"]);
    expect(await kinds("source=indiamart&kind=catalog_view")).toEqual(["catalog_view"]);
    expect((await inbox("source=google_lead_form")).body.enquiries).toEqual([]);
    const v = (await inbox()).body.vocabulary;
    expect(v.kinds.map((k) => [k.code, k.isEnquiry])).toEqual([
      ["buyer_enquiry", true], ["purchased_lead", false], ["catalog_view", false], ["unclassified", false],
    ]);
    expect(v.sources.map((x) => x.code)).toEqual(["google_lead_form", "indiamart"]);
  });

  test("24. a row: source and kind, no campaign, not processed, and no marketing permission because IndiaMART never asks", async () => {
    answers.push(ok([rec({ SENDER_MOBILE: "", SENDER_PHONE: "0421-222333", SENDER_EMAIL: "", SENDER_EMAIL_ALT: "alt@buyer.in" })]));
    await checkNow();
    const { body } = await inbox();
    expect(body.enquiries).toHaveLength(1);
    const row = body.enquiries[0];
    expect(Object.keys(row).sort()).toEqual([
      "campaign", "consent", "consentBasis", "contact", "ingestionOrigin", "kind", "processing",
      "receivedAt", "reviewReason", "source", "states", "submissionRef", "submittedAt",
    ]);
    expect(row).toMatchObject({
      source: "indiamart", kind: "buyer_enquiry", ingestionOrigin: "pull", campaign: null,
      processing: "not_processed", consent: "no_permission_recorded", consentBasis: "source_does_not_ask",
      reviewReason: null, states: ["lead_recorded"],
      submittedAt: "2026-09-20T04:45:00.000Z",
      receivedAt: new Date(NOW).toISOString(),
      contact: { name: "Ravi Kumar", companyName: "Kumar Textiles", hasEmail: true, hasPhone: true },
    });
    expect(row.submissionRef).toMatch(/^MSE-[a-f0-9]{16}$/);
    const v = body.vocabulary;
    expect(v.processing.map((p) => p.code)).toContain("not_processed");
    expect(v.consentBases.map((p) => p.code)).toContain("source_does_not_ask");
  });

  test("25. filters that only lead-form submissions can meet exclude IndiaMART; those it meets include it", async () => {
    answers.push(ok([rec()]));
    await checkNow();
    const n = async (qs) => (await inbox(qs)).body.page.total;
    expect(await n("consent=unknown")).toBe(0);
    expect(await n("consent=permission_recorded")).toBe(0);
    expect(await n("consent=no_permission_recorded")).toBe(1);
    expect(await n("processing=processing")).toBe(0);
    expect(await n("processing=not_processed")).toBe(1);
    expect(await n("campaign=MCP-2026-0001")).toBe(0);
    expect(await n("source=indiamart")).toBe(1);
    expect((await inbox("kind=nonsense")).status).toBe(400);
    expect((await inbox("source=facebook")).status).toBe(400);
  });

  test("26. pages across IndiaMART enquiries are newest first and complete", async () => {
    answers.push(ok([rec(), rec()]));
    await checkNow();
    later(5 * MINUTE);
    answers.push(ok([rec(), rec(), rec()]));
    await checkNow();
    const p1 = (await inbox("limit=2&page=1")).body;
    const p2 = (await inbox("limit=2&page=2")).body;
    const p3 = (await inbox("limit=2&page=3")).body;
    expect(p1.page).toEqual({ number: 1, size: 2, total: 5, pages: 3 });
    const all = [...p1.enquiries, ...p2.enquiries, ...p3.enquiries];
    expect(new Set(all.map((e) => e.submissionRef)).size).toBe(5);
    const times = all.map((e) => Date.parse(e.receivedAt));
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  test("27. detail keeps the original enquiry context and marks the placeholder name", async () => {
    answers.push(ok([rec({
      QUERY_TYPE: "P", CALL_DURATION: "95", RECEIVER_MOBILE: "+91-9000000001",
      SENDER_NAME: "IndiaMART Buyer", QUERY_TIME: "07-Dec-2021 09:00", QUERY_MESSAGE: "Line one\r\nLine two",
    })]));
    await checkNow();
    const ref = (await inbox()).body.enquiries[0].submissionRef;
    const d = await call("GET", `/enquiries/${ref}`, { user: MARKETER });
    expect(d.status).toBe(200);
    const e = d.body.enquiry;
    expect(e.contact.name).toBe("");
    expect(e.submittedAt).toBeNull();
    expect(e.enquiryContext).toMatchObject({
      sourceType: { code: "P", label: "Phone call" },
      nameIsPlaceholder: true,
      submittedAtAsSent: "07-Dec-2021 09:00",
    });
    const field = (f) => e.enquiryContext.fields.find((x) => x.field === f)?.value;
    expect(field("callDurationSeconds")).toBe(95);
    expect(field("productName")).toBe("Cotton T-shirts");
    expect(field("categoryName")).toBe("Men's T-Shirts");
    expect(field("subject")).toBe("Requirement for Cotton T-shirts");
    expect(field("message")).toBe("Line one\r\nLine two");
    expect(field("receiverPhone")).toBe("+91-9000000001");
    expect(e.supplied.find((s) => s.field === "phone")).toEqual({
      field: "phone", code: "SENDER_MOBILE", label: "Mobile number", value: "+91-9812345678", provenance: "source_reported",
    });
    expect(e.supplied.find((s) => s.field === "fullName")).toBeUndefined();
    expect(e).toMatchObject({
      source: "indiamart", kind: "buyer_enquiry", campaign: null, answers: [], unmapped: [], phoneVerified: null,
      processing: "not_processed", consent: "no_permission_recorded", consentBasis: "source_does_not_ask",
      lastProcessedAt: null,
    });
    expect((await call("GET", "/enquiries/MSE-0000000000000000", { user: MARKETER })).status).toBe(404);
  });
});

/* ═══ 6. PRIVACY AND TENANCY ══════════════════════════════════════════════ */

describe("privacy and tenancy", () => {
  test("28. the key, the URL, IndiaMART's ids and messages never leave; contact details only in the detail", async () => {
    const r = rec({ UNIQUE_QUERY_ID: "2987654399" });
    answers.push(ok([r], { MESSAGE: "Leads fetched successfully INTERNAL-NOTE" }));
    const c = await checkNow();
    const s = await status({ user: MARKETER });
    const list = await inbox();
    const ref = list.body.enquiries[0].submissionRef;
    const detail = await call("GET", `/enquiries/${ref}`, { user: MARKETER });
    for (const res of [c, s, list, detail]) {
      for (const secret of [KEY, "2987654399", "mapi.indiamart.com", "glusr_crm_key", "INTERNAL-NOTE", "externalEventKey", "leaseToken"]) {
        expect([secret, res.text.includes(secret)]).toEqual([secret, false]);
      }
    }
    for (const res of [c, s, list]) {
      for (const personal of ["9812345678", "ravi@kumartextiles.in", "Tiruppur"]) {
        expect([personal, res.text.includes(personal)]).toEqual([personal, false]);
      }
    }
    expect(detail.text).toContain("ravi@kumartextiles.in");

    /* And not in the database either. */
    const stored = JSON.stringify(await MarketingLeadSourceState.find({}).lean())
      + JSON.stringify(await MarketingSourceEnquiry.find({}).lean());
    expect(stored).not.toContain(KEY);
    expect(stored).not.toContain("glusr_crm_key");
  });

  test("29. another company: not connected, cannot check, and sees none of A's enquiries", async () => {
    answers.push(ok([rec()]));
    await checkNow();
    const ref = (await inbox()).body.enquiries[0].submissionRef;

    const s = (await status({ company: B })).body.indiamart;
    expect(s.connection.code).toBe("not_configured");
    expect(s.enquiries.total).toBe(0);
    expect(s.lastCheck).toBeNull();
    const c = await checkNow({ company: B });
    expect(c.status).toBe(409);
    expect(c.body.error.code).toBe("LEAD_SOURCE_NOT_CONFIGURED");
    expect(calls).toHaveLength(1);

    expect((await inbox("", { company: B })).body.page.total).toBe(0);
    expect((await call("GET", `/enquiries/${ref}`, { user: MARKETER, company: B })).status).toBe(404);
  });

  test("30. the same IndiaMART id in two companies is two records (dedupe is per company)", async () => {
    const { saveAll } = sync.__internals;
    const window = { from: new Date(NOW - DAY), to: new Date(NOW) };
    const r = rec();
    await saveAll({ companyId: A, records: [r], window, pulledAt: new Date(NOW) });
    const b = await saveAll({ companyId: B, records: [r], window, pulledAt: new Date(NOW) });
    expect(b.recorded).toBe(1);
    expect(await MarketingSourceEnquiry.countDocuments({})).toBe(2);
  });
});

/* ═══ 7. SIDE EFFECTS AND AUTHORITY ═══════════════════════════════════════ */

describe("side effects and authority", () => {
  /* Since routing (2026-09-22) Check now also routes buyer enquiries to Sales;
     that is pinned in indiamart-sales-routing.test.js. The PULL itself — and
     every read — still creates nothing outside the inbox. */
  test("31. the pull and the reads create no person, permission, receipt, Sales record or handover", async () => {
    const counts = async () => ({
      receipts: await MarketingLeadProcessingReceipt.countDocuments({}),
      identities: await MarketingIdentity.countDocuments({}),
      events: await MarketingIntentEvent.countDocuments({}),
      consent: await MarketingConsent.countDocuments({}),
      handovers: await ProspectHandover.countDocuments({}),
      salesLeads: await Lead.countDocuments({}),
      salesEnquiries: await Enquiry.countDocuments({}),
    });
    const before = await counts();
    answers.push(ok([rec(), rec({ QUERY_TYPE: "B" })]));
    await sync.check({ companyId: A, now: () => clock.now, transport });
    later(5 * MINUTE);
    answers.push(ok([rec()]));
    await sync.check({ companyId: A, now: () => clock.now, transport });
    const ref = (await inbox()).body.enquiries[0].submissionRef;
    await call("GET", `/enquiries/${ref}`, { user: MARKETER });
    await status();
    expect(await counts()).toEqual(before);
    expect(before).toEqual({ receipts: 0, identities: 0, events: 0, consent: 0, handovers: 0, salesLeads: 0, salesEnquiries: 0 });
  });

  test("32. reading status never calls IndiaMART", async () => {
    await status();
    await status({ user: MARKETER });
    await inbox();
    expect(calls).toHaveLength(0);
  });

  test("33. only an administrator or the CEO can check; a marketer reads; nothing can be named", async () => {
    const m = await checkNow({ user: MARKETER });
    expect(m.status).toBe(403);
    expect(calls).toHaveLength(0);
    expect((await status({ user: MARKETER })).status).toBe(200);
    expect((await status({ user: null })).status).toBe(401);
    expect((await call("GET", "/lead-sources/indiamart?companyId=x")).status).toBe(400);
    expect((await checkNow({ body: { start_time: "01-Jan-2026" } })).status).toBe(400);
    expect((await checkNow({ body: { key: "other" } })).status).toBe(400);
    expect(calls).toHaveLength(0);
    answers.push(ok([]));
    expect((await checkNow({ user: CEO })).status).toBe(200);
  });

  test("34. the Marketing guard classifies Check now as an administrator action and the status as a read", () => {
    expect(access.actFor("POST", "/lead-sources/indiamart/check")).toBe("administer");
    expect(access.actFor("GET", "/lead-sources/indiamart")).toBe("read");
  });

  test("35. the enquiry record is append-only", async () => {
    answers.push(ok([rec()]));
    await checkNow();
    await expect(MarketingSourceEnquiry.updateOne({}, { $set: { kind: "catalog_view" } })).rejects.toThrow(/append-only/);
    await expect(MarketingSourceEnquiry.deleteMany({})).rejects.toThrow(/append-only/);
    const doc = await MarketingSourceEnquiry.findOne({});
    doc.kind = "catalog_view";
    await expect(doc.save()).rejects.toThrow(/append-only/);
  });
});
