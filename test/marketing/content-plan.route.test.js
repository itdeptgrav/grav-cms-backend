// test/marketing/content-plan.route.test.js
//
// THE CONTENT PLANNER, OVER ITS REAL ROUTES.
//
// ── WHAT THIS PINS ─────────────────────────────────────────────────────────
//   Month boundaries and time zones place an item on the day it falls for the
//   person looking; an all-day item keeps its own date.
//   Overlapping items all appear, and say so. An empty range is a full grid of
//   empty days, not an error.
//   Another company's item, plan, owner or asset is invisible.
//   Marketing drafts and submits; administrators and the CEO approve; nobody
//   approves their own submission; Sales never gets in.
//   A stale edit is refused, never merged, and exactly one of two racing edits
//   lands.
//   A link to a campaign plan or content asset that does not exist is refused,
//   and a library that cannot be read confirms nothing.
//   "Published" appears only when the content library says so. Planned dates
//   are never reported as actual ones, and nothing is written anywhere outside
//   GRAV.
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
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const { MarketingContentPlanItem } = require("../../models/CMS_Models/Marketing/MarketingContentPlanItem");
const drafts = require("../../services/marketing/campaignDrafts/campaignDraft.service");
const C = require("../../constants/marketingContentPlan");

const oid = () => new mongoose.Types.ObjectId().toString();
const MARKETER = { id: oid(), name: "Mo", role: "marketing", email: "mo@grav.in" };
const MARKETER_2 = { id: oid(), name: "Meera", role: "marketing", email: "meera@grav.in" };
const ADMIN = { id: oid(), name: "Ada", role: "admin", email: "ada@grav.in" };
const ADMIN_2 = { id: oid(), name: "Aru", role: "admin", email: "aru@grav.in" };
const CEO = { id: oid(), name: "Chandra", role: "ceo", email: "ceo@grav.in" };
const SALES = { id: oid(), name: "Sal", role: "sales", email: "sal@grav.in" };

/* ── A CONTENT LIBRARY THAT CAN BE READ, CHANGED AND BROKEN ──────────────── */
const library = {
  email: [], form: [], landing_page: [],
  down: false,
  calls: [],
};
const fakeClient = {
  async listContent(kind, { start = 0, limit = 25 } = {}) {
    library.calls.push({ method: "GET", kind, start, limit });
    if (library.down) {
      const err = new Error("unreachable");
      err.code = "MAUTIC_UNAVAILABLE";
      throw err;
    }
    const rows = library[kind].slice(start, start + limit);
    return { rows, total: library[kind].length, start, limit };
  },
};

let A; let B;
let server; let base; let app;
let seq = 0;
const fresh = (p) => `${p}-${Date.now()}-${(seq += 1)}`;
const ENV_KEYS = ["MARKETING_CHANNEL_ID_SECRET", "MARKETING_COMPANY_ID"];
const saved = {};

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  app = express();
  app.locals.marketingContentClient = fakeClient;
  app.use((req, res, next) => {
    const c = String(req.headers["x-test-company"] || "");
    if (mongoose.Types.ObjectId.isValid(c)) req.__marketingCompanyId = new mongoose.Types.ObjectId(c);
    next();
  });
  app.use("/api/cms/marketing", require("../../routes/CMS_Routes/Marketing/contentPlan"));
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
  process.env.MARKETING_CHANNEL_ID_SECRET = "a-deployment-secret-long-enough";
  process.env.MARKETING_COMPANY_ID = String(A);
  library.email = [];
  library.form = [];
  library.landing_page = [];
  library.down = false;
  library.calls = [];
  await SpCompanyMembership.create([
    { companyId: A, email: MARKETER.email, personName: "Mo Khan", employeeRef: oid() },
    { companyId: A, email: MARKETER_2.email, personName: "Meera Iyer", employeeRef: oid() },
    { companyId: A, email: ADMIN.email, personName: "Ada Rao", employeeRef: oid() },
    { companyId: B, email: "bob@other.co", personName: "Bob Other", employeeRef: oid() },
  ]);
});

/* ═══ HTTP ════════════════════════════════════════════════════════════════ */

async function call(method, path, { user = MARKETER, company = A, body } = {}) {
  const headers = { "x-test-company": String(company), "content-type": "application/json" };
  if (user) headers["x-test-user"] = JSON.stringify(user);
  const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { json = null; }
  return { status: res.status, body: json, text };
}
const get = (path, opts) => call("GET", path, opts);
const post = (path, body, opts = {}) => call("POST", path, { ...opts, body });
const patch = (path, body, opts = {}) => call("PATCH", path, { ...opts, body });

const BASE_ITEM = Object.freeze({
  title: "Winter uniforms launch email",
  contentType: "email",
  channel: "email",
  brief: "Announce the winter range to hotel buyers.",
});

async function createItem(over = {}, opts = {}) {
  const res = await post("/content-plan/items", { idempotencyKey: fresh("key-create"), ...BASE_ITEM, ...over }, opts);
  if (res.status !== 201) throw new Error(`create failed ${res.status} ${res.text}`);
  return res.body.item;
}

const act = (item, action, { user = MARKETER, reason, revision } = {}) => post(
  `/content-plan/items/${item.itemRef}/actions`,
  { expectedRevision: revision ?? item.revision, action, ...(reason ? { reason } : {}) },
  { user },
);

async function planFor(companyId, user = MARKETER) {
  const created = await drafts.create({
    companyId, user,
    payload: {
      name: "Winter campaign", objective: "awareness", channels: ["google_ads"],
      startDate: "2026-10-01", endDate: "2026-12-15", budgetAmount: 1000, budgetCurrency: "INR", budgetBasis: "daily",
      conversionGoal: "form_submission", utmCampaign: fresh("wc"), idempotencyKey: fresh("create-key-000"),
    },
  });
  return created;
}

/* An item ready to submit: brief, owner and a planned date. */
async function readyItem(over = {}, opts = {}) {
  return createItem({ ownerRef: "self", planned: { date: "2026-10-15", time: "10:00", timeZone: "Asia/Kolkata" }, ...over }, opts);
}

const calendarOf = (qs, opts) => get(`/content-plan/calendar?${qs}`, opts);

/* ═══ 1. CREATE AND READ ══════════════════════════════════════════════════ */

describe("create and read", () => {
  test("1. an item is created as an idea, with its history, and reads back field by field", async () => {
    const plan = await planFor(A);
    const res = await post("/content-plan/items", {
      idempotencyKey: fresh("key-create"),
      ...BASE_ITEM,
      notes: "Check the price list first.",
      campaignDraftId: plan.campaignDraftId,
      ownerRef: "self",
      planned: { date: "2026-10-15", time: "10:00", timeZone: "Asia/Kolkata" },
    });
    expect(res.status).toBe(201);
    expect(res.body.duplicate).toBe(false);
    const item = res.body.item;
    expect(item.itemRef).toMatch(/^MCI-[0-9a-f]{18}$/);
    expect(item.revision).toBe(1);
    expect(item.state.code).toBe("idea");
    expect(item.contentType).toEqual({ code: "email", label: "Email" });
    expect(item.channel).toEqual({ code: "email", label: "Email" });
    expect(item.planned).toEqual({
      date: "2026-10-15", time: "10:00", timeZone: "Asia/Kolkata", allDay: false, startsAt: "2026-10-15T04:30:00.000Z",
    });
    expect(item.owner).toEqual({ name: "Mo Khan", isYou: true });
    expect(item.campaign).toEqual({
      link: "linked", campaignDraftId: plan.campaignDraftId, reference: plan.reference || item.campaign.reference,
      name: "Winter campaign", state: "draft",
    });
    expect(item.publication.code).toBe("no_linked_asset");
    expect(item.actual).toEqual({ scheduledAt: null, publishedAt: null, source: null, checkedAt: null });
    expect(item.brief).toBe(BASE_ITEM.brief);
    expect(item.notes).toBe("Check the price list first.");
    expect(item.history).toEqual([expect.objectContaining({
      revision: 1, action: "created", fromState: null, toState: "idea", by: "Mo",
    })]);
    expect(res.body.contentLibrary.code).toBe("not_needed");
    expect(res.body.permissions).toEqual(expect.objectContaining({ canCreate: true, canApprove: false }));

    const again = await get(`/content-plan/items/${item.itemRef}`);
    expect(again.status).toBe(200);
    expect(again.body.item).toEqual(item);
  });

  test("2. the same key and body is one item; the same key with a different body is refused", async () => {
    const key = fresh("key-create");
    const first = await post("/content-plan/items", { idempotencyKey: key, ...BASE_ITEM });
    const second = await post("/content-plan/items", { idempotencyKey: key, ...BASE_ITEM });
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);
    expect(second.body.item.itemRef).toBe(first.body.item.itemRef);

    const different = await post("/content-plan/items", { idempotencyKey: key, ...BASE_ITEM, title: "Another" });
    expect(different.status).toBe(409);
    expect(different.body.error.code).toBe("CONTENT_PLAN_KEY_REUSED");
    expect(await MarketingContentPlanItem.countDocuments({ companyId: A })).toBe(1);
  });

  test("3. strict validation refuses, and writes nothing", async () => {
    const cases = [
      [{ ...BASE_ITEM }, "no key"],
      [{ idempotencyKey: "short", ...BASE_ITEM }, "short key"],
      [{ idempotencyKey: fresh("key-x"), contentType: "email", channel: "email" }, "no title"],
      [{ idempotencyKey: fresh("key-x"), ...BASE_ITEM, title: "x".repeat(C.LIMITS.TITLE_MAX + 1) }, "long title"],
      [{ idempotencyKey: fresh("key-x"), ...BASE_ITEM, contentType: "tweet" }, "bad type"],
      [{ idempotencyKey: fresh("key-x"), ...BASE_ITEM, channel: "google_ads" }, "provider channel"],
      [{ idempotencyKey: fresh("key-x"), ...BASE_ITEM, brief: "<script>alert(1)</script>" }, "markup"],
      [{ idempotencyKey: fresh("key-x"), ...BASE_ITEM, state: "approved" }, "state in body"],
      [{ idempotencyKey: fresh("key-x"), ...BASE_ITEM, publishedAt: "2026-10-01T00:00:00Z" }, "typed publication"],
      [{ idempotencyKey: fresh("key-x"), ...BASE_ITEM, planned: { date: "2026-02-30", timeZone: "Asia/Kolkata" } }, "30 Feb"],
      [{ idempotencyKey: fresh("key-x"), ...BASE_ITEM, planned: { date: "2026-10-01", timeZone: "Mars/Olympus" } }, "bad zone"],
      [{ idempotencyKey: fresh("key-x"), ...BASE_ITEM, planned: { date: "2026-10-01", time: "25:00", timeZone: "Asia/Kolkata" } }, "bad time"],
      [{ idempotencyKey: fresh("key-x"), ...BASE_ITEM, planned: { date: "2026-10-01", timeZone: "Asia/Kolkata", at: "x" } }, "extra planned key"],
      [{ idempotencyKey: fresh("key-x"), ...BASE_ITEM, planned: { date: "2026-03-08", time: "02:30", timeZone: "America/New_York" } }, "clock gap"],
      [{ idempotencyKey: fresh("key-x"), ...BASE_ITEM, planned: { date: "1999-12-31", timeZone: "Asia/Kolkata" } }, "year"],
      [{ idempotencyKey: fresh("key-x"), ...BASE_ITEM, assetLink: { kind: "email", contentId: "https://x/y" } }, "url as asset"],
      [{ idempotencyKey: fresh("key-x"), ...BASE_ITEM, assetLink: { kind: "landing_page", contentId: "12" } }, "kind mismatch"],
      [{ idempotencyKey: fresh("key-x"), ...BASE_ITEM, ownerRef: "" }, "empty owner"],
    ];
    for (const [body, why] of cases) {
      const res = await post("/content-plan/items", body);
      expect([why, res.status]).toEqual([why, 400]);
      expect(res.body.success).toBe(false);
    }
    expect(await MarketingContentPlanItem.countDocuments({})).toBe(0);
  });
});

/* ═══ 2. THE CALENDAR ═════════════════════════════════════════════════════ */

describe("calendar", () => {
  test("4. month boundaries fall where the viewer's zone puts them", async () => {
    /* 23:30 on 31 October in India is 18:00 UTC the same day. */
    const lateOct = await createItem({ title: "Late October", planned: { date: "2026-10-31", time: "23:30", timeZone: "Asia/Kolkata" } });
    /* 01:00 on 1 November in India is 19:30 UTC on 31 October. */
    const earlyNov = await createItem({ title: "Early November", planned: { date: "2026-11-01", time: "01:00", timeZone: "Asia/Kolkata" } });
    /* An all-day item is on its own date in every zone. */
    const allDay = await createItem({ title: "All day", planned: { date: "2026-10-31", timeZone: "America/New_York" } });

    const refs = (body) => body.items.map((i) => i.itemRef).sort();

    const octIndia = (await calendarOf("from=2026-10-01&to=2026-10-31&timeZone=Asia/Kolkata")).body;
    expect(refs(octIndia)).toEqual([lateOct.itemRef, allDay.itemRef].sort());
    const novIndia = (await calendarOf("from=2026-11-01&to=2026-11-30&timeZone=Asia/Kolkata")).body;
    expect(refs(novIndia)).toEqual([earlyNov.itemRef]);
    expect(novIndia.days[0]).toEqual({ date: "2026-11-01", weekday: "Sunday", items: [earlyNov.itemRef] });

    const octUtc = (await calendarOf("from=2026-10-01&to=2026-10-31&timeZone=UTC")).body;
    expect(refs(octUtc)).toEqual([lateOct.itemRef, earlyNov.itemRef, allDay.itemRef].sort());
    const last = octUtc.days.find((d) => d.date === "2026-10-31");
    /* All-day first, then by local time. */
    expect(last.items).toEqual([allDay.itemRef, lateOct.itemRef, earlyNov.itemRef]);
    const shown = Object.fromEntries(octUtc.items.map((i) => [i.itemRef, i.planned.display]));
    expect(shown[lateOct.itemRef]).toEqual({ date: "2026-10-31", time: "18:00", timeZone: "UTC" });
    expect(shown[earlyNov.itemRef]).toEqual({ date: "2026-10-31", time: "19:30", timeZone: "UTC" });
    expect(shown[allDay.itemRef]).toEqual({ date: "2026-10-31", time: null, timeZone: "UTC" });
    expect((await calendarOf("from=2026-11-01&to=2026-11-30&timeZone=UTC")).body.items).toEqual([]);

    /* What was typed is never rewritten by where it is read. */
    const typed = octUtc.items.find((i) => i.itemRef === earlyNov.itemRef).planned;
    expect([typed.date, typed.time, typed.timeZone]).toEqual(["2026-11-01", "01:00", "Asia/Kolkata"]);
  });

  test("5. clocks going back: the first 01:30 is the one planned, and it reads back as typed", async () => {
    const item = await createItem({ planned: { date: "2026-11-01", time: "01:30", timeZone: "America/New_York" } });
    expect(item.planned.startsAt).toBe("2026-11-01T05:30:00.000Z");
    const view = (await calendarOf("from=2026-11-01&to=2026-11-01&timeZone=America/New_York")).body;
    expect(view.items[0].planned.display).toEqual({ date: "2026-11-01", time: "01:30", timeZone: "America/New_York" });
  });

  test("6. overlapping items all appear, and each says how many share its slot", async () => {
    const at10 = { date: "2026-10-20", time: "10:00", timeZone: "Asia/Kolkata" };
    const a = await createItem({ title: "A", planned: at10 });
    const b = await createItem({ title: "B", planned: at10 });
    const c = await createItem({ title: "C", planned: { ...at10, time: "10:30" } });
    const d = await createItem({ title: "D", planned: { ...at10, date: "2026-10-21" } });

    const view = (await calendarOf("from=2026-10-01&to=2026-10-31&timeZone=Asia/Kolkata")).body;
    const byRef = Object.fromEntries(view.items.map((i) => [i.itemRef, i]));
    expect(byRef[a.itemRef].overlapsWith).toBe(1);
    expect(byRef[b.itemRef].overlapsWith).toBe(1);
    expect(byRef[c.itemRef].overlapsWith).toBe(0);
    expect(byRef[d.itemRef].overlapsWith).toBe(0);
    expect(view.days.find((x) => x.date === "2026-10-20").items).toEqual([a.itemRef, b.itemRef, c.itemRef]);
  });

  test("7. an empty range is a full grid of empty days", async () => {
    const view = await calendarOf("from=2026-02-01&to=2026-02-28&timeZone=Asia/Kolkata");
    expect(view.status).toBe(200);
    expect(view.body.empty).toBe(true);
    expect(view.body.items).toEqual([]);
    expect(view.body.days).toHaveLength(28);
    expect(view.body.days.every((d) => d.items.length === 0)).toBe(true);
    expect(view.body.range).toEqual({ from: "2026-02-01", to: "2026-02-28", timeZone: "Asia/Kolkata", days: 28 });
    expect(view.body.contentLibrary.code).toBe("not_needed");
    expect(library.calls).toEqual([]);

    /* No zone named: GRAV's own. */
    expect((await calendarOf("from=2026-02-01&to=2026-02-01")).body.range.timeZone).toBe(C.DEFAULT_TIME_ZONE);
  });

  test("8. bad ranges and filters are refused; cancelled items stay off unless asked for", async () => {
    for (const qs of [
      "", "from=2026-10-01", "from=2026-10-31&to=2026-10-01", "from=2026-01-01&to=2026-03-15",
      "from=2026-10-01&to=2026-10-31&timeZone=Nowhere/Land", "from=2026-10-01&to=2026-10-31&state=published",
      "from=2026-10-01&to=2026-10-31&companyId=abc",
    ]) {
      expect([qs, (await calendarOf(qs)).status]).toEqual([qs, 400]);
    }
    const item = await createItem({ planned: { date: "2026-10-10", timeZone: "Asia/Kolkata" } });
    await act(item, "cancel");
    expect((await calendarOf("from=2026-10-01&to=2026-10-31")).body.items).toEqual([]);
    expect((await calendarOf("from=2026-10-01&to=2026-10-31&state=cancelled")).body.items.map((i) => i.itemRef))
      .toEqual([item.itemRef]);
  });

  test("9. the list carries undated ideas too, and pages them", async () => {
    await createItem({ title: "Undated" });
    await createItem({ title: "Dated", planned: { date: "2026-10-10", timeZone: "Asia/Kolkata" } });
    const all = (await get("/content-plan/items")).body;
    expect(all.items.map((i) => i.title)).toEqual(["Dated", "Undated"]);
    expect(all.page).toEqual({ number: 1, size: 25, total: 2, pages: 1 });
    expect((await get("/content-plan/items?dated=unplanned")).body.items.map((i) => i.title)).toEqual(["Undated"]);
    expect((await get("/content-plan/items?limit=1&page=2")).body.items.map((i) => i.title)).toEqual(["Undated"]);
    expect((await get("/content-plan/items?limit=101")).status).toBe(400);
  });
});

/* ═══ 3. TENANCY ══════════════════════════════════════════════════════════ */

describe("company isolation", () => {
  test("10. another company's items, plans and owners are invisible", async () => {
    const mine = await createItem({ planned: { date: "2026-10-10", timeZone: "Asia/Kolkata" } });
    const theirs = await createItem({ planned: { date: "2026-10-10", timeZone: "Asia/Kolkata" } }, { company: B });

    expect((await calendarOf("from=2026-10-01&to=2026-10-31")).body.items.map((i) => i.itemRef)).toEqual([mine.itemRef]);
    expect((await get("/content-plan/items")).body.items.map((i) => i.itemRef)).toEqual([mine.itemRef]);

    const foreign = await get(`/content-plan/items/${theirs.itemRef}`);
    const missing = await get("/content-plan/items/MCI-000000000000000000");
    expect(foreign.status).toBe(404);
    expect(foreign.text).toBe(missing.text);
    expect((await patch(`/content-plan/items/${theirs.itemRef}`, { expectedRevision: 1, title: "Mine now" })).status).toBe(404);
    expect((await act(theirs, "cancel")).status).toBe(404);

    const theirPlan = await planFor(B);
    const linked = await post("/content-plan/items", { idempotencyKey: fresh("key-c"), ...BASE_ITEM, campaignDraftId: theirPlan.campaignDraftId });
    expect(linked.status).toBe(422);
    expect(linked.body.error.code).toBe("CONTENT_PLAN_LINK_NOT_FOUND");

    const theirOwners = (await get("/content-plan/owners", { company: B, user: { ...MARKETER, email: "bob@other.co" } })).body.owners;
    const borrowed = await post("/content-plan/items", { idempotencyKey: fresh("key-o"), ...BASE_ITEM, ownerRef: theirOwners[0].ownerRef });
    expect(borrowed.status).toBe(422);
    expect(borrowed.body.error.code).toBe("CONTENT_PLAN_LINK_NOT_FOUND");
  });

  test("11. the owners list names people, never their addresses or ids", async () => {
    const res = await get("/content-plan/owners");
    expect(res.status).toBe(200);
    expect(res.body.assignable).toBe(true);
    expect(res.body.owners.map((o) => o.name)).toEqual(["Ada Rao", "Meera Iyer", "Mo Khan"]);
    expect(res.body.owners.find((o) => o.name === "Mo Khan").isYou).toBe(true);
    expect(res.text).not.toMatch(/@|employeeRef|membership|"_id"/);

    const meera = res.body.owners.find((o) => o.name === "Meera Iyer");
    const item = await createItem({ ownerRef: meera.ownerRef });
    expect(item.owner).toEqual({ name: "Meera Iyer", isYou: false });
    expect((await get(`/content-plan/items/${item.itemRef}`, { user: MARKETER_2 })).body.item.owner.isYou).toBe(true);
    expect((await get("/content-plan/items?owner=mine", { user: MARKETER_2 })).body.items.map((i) => i.itemRef)).toEqual([item.itemRef]);
  });
});

/* ═══ 4. WHO MAY DO WHAT ══════════════════════════════════════════════════ */

describe("permissions", () => {
  test("12. signed out and Sales are refused on every route", async () => {
    const item = await createItem();
    for (const user of [null, SALES]) {
      const want = user ? 403 : 401;
      expect((await get("/content-plan/calendar?from=2026-10-01&to=2026-10-31", { user })).status).toBe(want);
      expect((await get("/content-plan/items", { user })).status).toBe(want);
      expect((await get(`/content-plan/items/${item.itemRef}`, { user })).status).toBe(want);
      expect((await post("/content-plan/items", { idempotencyKey: fresh("k-sales"), ...BASE_ITEM }, { user })).status).toBe(want);
      expect((await patch(`/content-plan/items/${item.itemRef}`, { expectedRevision: 1, title: "x" }, { user })).status).toBe(want);
      expect((await act(item, "start", { user })).status).toBe(want);
    }
  });

  test("13. Marketing drafts and submits; only an administrator or the CEO approves, and never their own", async () => {
    const item = await readyItem();
    const submitted = await act(item, "submit");
    expect(submitted.status).toBe(200);
    expect(submitted.body.item.state.code).toBe("in_review");
    expect(submitted.body.item.viewerActions.approve).toEqual({ allowed: false, reason: "approver_only", reasonRequired: false });

    const byMarketing = await act(submitted.body.item, "approve", { user: MARKETER_2 });
    expect(byMarketing.status).toBe(403);
    expect(byMarketing.body.error.code).toBe("CONTENT_PLAN_DECISION_FORBIDDEN");
    expect((await act(submitted.body.item, "return", { user: MARKETER_2, reason: "no" })).status).toBe(403);

    const adminView = (await get(`/content-plan/items/${item.itemRef}`, { user: ADMIN })).body;
    expect(adminView.permissions.canApprove).toBe(true);
    expect(adminView.item.viewerActions.approve.allowed).toBe(true);

    const approved = await act(submitted.body.item, "approve", { user: ADMIN });
    expect(approved.status).toBe(200);
    expect(approved.body.item.state.code).toBe("approved");
    expect(approved.body.item.submission).toEqual(expect.objectContaining({ submittedBy: "Mo", approvedBy: "Ada" }));

    /* An administrator who submitted cannot approve their own. */
    const adminItem = await readyItem({}, { user: ADMIN });
    const adminSubmitted = (await act(adminItem, "submit", { user: ADMIN })).body.item;
    expect(adminSubmitted.viewerActions.approve).toEqual({ allowed: false, reason: "own_submission", reasonRequired: false });
    const self = await act(adminSubmitted, "approve", { user: ADMIN });
    expect(self.status).toBe(403);
    expect(self.body.error.message).toMatch(/somebody else/);
    expect((await act(adminSubmitted, "approve", { user: CEO })).status).toBe(200);
  });

  test("14. an approver returns with a reason; reopening an approved item needs one and clears the approval", async () => {
    const item = await readyItem();
    const inReview = (await act(item, "submit")).body.item;
    expect((await act(inReview, "return", { user: ADMIN })).status).toBe(400);
    const returned = (await act(inReview, "return", { user: ADMIN, reason: "Add the price." })).body.item;
    expect(returned.state.code).toBe("drafting");

    const again = (await act(returned, "submit")).body.item;
    const approved = (await act(again, "approve", { user: ADMIN_2 })).body.item;
    expect((await act(approved, "reopen")).status).toBe(400);
    const reopened = await act(approved, "reopen", { reason: "Date moved." });
    expect(reopened.status).toBe(200);
    expect(reopened.body.item.state.code).toBe("drafting");
    expect(reopened.body.item.submission.approvedBy).toBeNull();

    const history = reopened.body.item.history.map((h) => [h.action, h.toState, h.by]);
    expect(history).toEqual([
      ["created", "idea", "Mo"], ["submit", "in_review", "Mo"], ["return", "drafting", "Ada"],
      ["submit", "in_review", "Mo"], ["approve", "approved", "Aru"], ["reopen", "drafting", "Mo"],
    ]);
    expect(reopened.body.item.history[2].reason).toBe("Add the price.");
  });

  test("15. an item cannot be submitted incomplete, and cancelling an approved item is an approver's call", async () => {
    const bare = await createItem({ brief: "" });
    const refused = await act(bare, "submit");
    expect(refused.status).toBe(409);
    expect(refused.body.error.details.missing).toEqual(["brief", "owner", "planned"]);
    expect((await get(`/content-plan/items/${bare.itemRef}`)).body.item.viewerActions.submit.reason).toBe("incomplete");

    const item = await readyItem();
    const approved = (await act((await act(item, "submit")).body.item, "approve", { user: ADMIN })).body.item;
    expect((await act(approved, "cancel")).status).toBe(409);
    expect((await act(approved, "cancel_approved", { reason: "Dropped." })).status).toBe(403);
    const cancelled = await act(approved, "cancel_approved", { user: ADMIN, reason: "Dropped." });
    expect(cancelled.body.item.state.code).toBe("cancelled");
    expect((await act(cancelled.body.item, "start")).status).toBe(409);
    expect((await act(cancelled.body.item, "publish")).status).toBe(400);
  });
});

/* ═══ 5. COMPETING EDITS ══════════════════════════════════════════════════ */

describe("revisions", () => {
  test("16. a stale edit is refused and changes nothing", async () => {
    const item = await createItem();
    const first = await patch(`/content-plan/items/${item.itemRef}`, { expectedRevision: 1, title: "First edit" });
    expect(first.status).toBe(200);
    expect(first.body.item.revision).toBe(2);

    const stale = await patch(`/content-plan/items/${item.itemRef}`, { expectedRevision: 1, title: "Stale edit" }, { user: MARKETER_2 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("CONTENT_PLAN_REVISION_CONFLICT");
    expect(stale.body.error.details).toEqual(expect.objectContaining({ currentRevision: 2, sentRevision: 1 }));
    const now = (await get(`/content-plan/items/${item.itemRef}`)).body.item;
    expect(now.title).toBe("First edit");
    expect(now.history).toHaveLength(2);

    expect((await act(item, "start", { revision: 1 })).status).toBe(409);
    for (const expectedRevision of [undefined, "2", 0, 2.5, null]) {
      const body = expectedRevision === undefined ? { title: "x" } : { expectedRevision, title: "x" };
      expect((await patch(`/content-plan/items/${item.itemRef}`, body)).status).toBe(400);
    }
  });

  test("17. of two edits racing from the same revision, exactly one lands", async () => {
    const item = await createItem();
    const results = await Promise.all([
      patch(`/content-plan/items/${item.itemRef}`, { expectedRevision: 1, title: "Racer one" }),
      patch(`/content-plan/items/${item.itemRef}`, { expectedRevision: 1, title: "Racer two" }, { user: MARKETER_2 }),
      act(item, "start", { user: MARKETER_2 }),
    ]);
    const codes = results.map((r) => r.status).sort();
    expect(codes).toEqual([200, 409, 409]);
    const stored = await MarketingContentPlanItem.findOne({ itemRef: item.itemRef }).lean();
    expect(stored.revision).toBe(2);
    expect(stored.history).toHaveLength(2);
  });

  test("18. an unchanged edit writes nothing; a retried action is reported, not repeated", async () => {
    const item = await createItem();
    const same = await patch(`/content-plan/items/${item.itemRef}`, { expectedRevision: 1, title: BASE_ITEM.title });
    expect(same.status).toBe(200);
    expect(same.body.unchanged).toBe(true);
    expect(same.body.item.revision).toBe(1);

    const once = await act(item, "start");
    const retry = await act(item, "start");
    expect(once.body.duplicate).toBe(false);
    expect(retry.status).toBe(200);
    expect(retry.body.duplicate).toBe(true);
    expect(retry.body.item.revision).toBe(2);
  });

  test("19. a submitted item is frozen except its notes; a cancelled one entirely", async () => {
    const item = await readyItem();
    const inReview = (await act(item, "submit")).body.item;
    const frozen = await patch(`/content-plan/items/${item.itemRef}`, { expectedRevision: inReview.revision, title: "Sneaky" });
    expect(frozen.status).toBe(409);
    expect(frozen.body.error.details.blockedFields).toEqual(["title"]);
    const notes = await patch(`/content-plan/items/${item.itemRef}`, { expectedRevision: inReview.revision, notes: "Approver asked for a date check." });
    expect(notes.status).toBe(200);
    expect(notes.body.item.state.code).toBe("in_review");
    expect(notes.body.item.history.at(-1)).toEqual(expect.objectContaining({ action: "edited", changedFields: ["notes"] }));

    const cancelled = (await act(notes.body.item, "cancel")).body.item;
    expect((await patch(`/content-plan/items/${item.itemRef}`, { expectedRevision: cancelled.revision, notes: "x" })).status).toBe(409);
  });

  test("20. the history cannot be edited or the item deleted, even directly", async () => {
    const item = await createItem();
    await expect(MarketingContentPlanItem.updateOne({ itemRef: item.itemRef }, { $set: { history: [] } })).rejects.toThrow(/append-only/);
    await expect(MarketingContentPlanItem.updateOne({ itemRef: item.itemRef }, { $pull: { history: { revision: 1 } } })).rejects.toThrow(/append-only/);
    await expect(MarketingContentPlanItem.deleteOne({ itemRef: item.itemRef })).rejects.toThrow(/append-only/);
  });
});

/* ═══ 6. LINKS ════════════════════════════════════════════════════════════ */

describe("links", () => {
  test("21. a campaign plan that does not exist, or is cancelled, cannot be linked", async () => {
    for (const campaignDraftId of ["not-a-plan", "ZDEuMTIzLjQ1Ng.abc"]) {
      const res = await post("/content-plan/items", { idempotencyKey: fresh("key-c"), ...BASE_ITEM, campaignDraftId });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe("CONTENT_PLAN_LINK_NOT_FOUND");
    }
    const plan = await planFor(A);
    await drafts.cancel({ companyId: A, user: MARKETER, campaignDraftId: plan.campaignDraftId, reason: "Dropped" });
    const res = await post("/content-plan/items", { idempotencyKey: fresh("key-c"), ...BASE_ITEM, campaignDraftId: plan.campaignDraftId });
    expect(res.status).toBe(422);
    expect(await MarketingContentPlanItem.countDocuments({})).toBe(0);
  });

  test("22. an asset must be confirmed in the content library; missing or unreadable is refused", async () => {
    library.email = [{ id: 12, name: "Winter launch", isPublished: false }];

    const missing = await post("/content-plan/items", { idempotencyKey: fresh("key-a"), ...BASE_ITEM, assetLink: { kind: "email", contentId: "99" } });
    expect(missing.status).toBe(422);
    expect(missing.body.error.code).toBe("CONTENT_PLAN_LINK_NOT_FOUND");

    library.down = true;
    const down = await post("/content-plan/items", { idempotencyKey: fresh("key-a"), ...BASE_ITEM, assetLink: { kind: "email", contentId: "12" } });
    expect(down.status).toBe(503);
    expect(down.body.error.code).toBe("CONTENT_PLAN_LINK_UNCONFIRMED");
    expect(await MarketingContentPlanItem.countDocuments({})).toBe(0);

    library.down = false;
    const ok = await post("/content-plan/items", { idempotencyKey: fresh("key-a"), ...BASE_ITEM, assetLink: { kind: "email", contentId: "12" } });
    expect(ok.status).toBe(201);
    expect(ok.body.item.asset).toEqual({ kind: { code: "email", label: "Email" }, name: "Winter launch", nameIsSnapshot: true });
    expect(ok.body.item.publication.code).toBe("not_published");

    /* A company with no content library has nothing to link to. */
    const other = await post("/content-plan/items", { idempotencyKey: fresh("key-a"), ...BASE_ITEM, assetLink: { kind: "email", contentId: "12" } }, { company: B });
    expect(other.status).toBe(503);
    expect(other.body.error.message).toMatch(/no content library/);
  });

  test("23. a library larger than one read never makes an asset 'missing'", async () => {
    library.email = Array.from({ length: 50 * C.LIMITS.LIBRARY_PAGES_PER_KIND + 5 }, (_, i) => ({ id: i + 1, name: `E${i + 1}`, isPublished: true }));
    const unseen = await post("/content-plan/items", { idempotencyKey: fresh("key-a"), ...BASE_ITEM, assetLink: { kind: "email", contentId: "999999" } });
    expect(unseen.status).toBe(503);
    expect(unseen.body.error.code).toBe("CONTENT_PLAN_LINK_UNCONFIRMED");
  });
});

/* ═══ 7. PLANNED IS NOT PUBLISHED ═════════════════════════════════════════ */

describe("publication", () => {
  test("24. 'published' and actual dates come only from the content library", async () => {
    library.email = [
      { id: 1, name: "Live", isPublished: true, publishUp: "2026-09-01T09:00:00+00:00" },
      { id: 2, name: "Queued", isPublished: true, publishUp: "2099-01-01T09:00:00+00:00" },
      { id: 3, name: "Unknown", isPublished: "yes" },
      { id: 4, name: "Expired", isPublished: true, publishUp: "2026-01-01T00:00:00+00:00", publishDown: "2026-02-01T00:00:00+00:00" },
    ];
    const planned = { date: "2026-10-10", time: "09:00", timeZone: "Asia/Kolkata" };
    const noAsset = await readyItem();
    const live = await createItem({ title: "Live", planned, assetLink: { kind: "email", contentId: "1" } });
    const queued = await createItem({ title: "Queued", planned, assetLink: { kind: "email", contentId: "2" } });
    const unknown = await createItem({ title: "Unknown", planned, assetLink: { kind: "email", contentId: "3" } });
    const expired = await createItem({ title: "Expired", planned, assetLink: { kind: "email", contentId: "4" } });

    /* Approval is not publication. */
    const approved = (await act((await act(noAsset, "submit")).body.item, "approve", { user: ADMIN })).body.item;
    expect(approved.publication.code).toBe("no_linked_asset");
    expect(approved.actual).toEqual({ scheduledAt: null, publishedAt: null, source: null, checkedAt: null });

    const view = (await calendarOf("from=2026-10-01&to=2026-10-31&timeZone=Asia/Kolkata")).body;
    expect(view.contentLibrary.code).toBe("available");
    const byRef = Object.fromEntries(view.items.map((i) => [i.itemRef, i]));
    expect(byRef[live.itemRef].publication.code).toBe("published");
    expect(byRef[live.itemRef].actual).toEqual(expect.objectContaining({
      publishedAt: "2026-09-01T09:00:00.000Z", scheduledAt: null, source: "content_library",
    }));
    expect(byRef[live.itemRef].planned.startsAt).toBe("2026-10-10T03:30:00.000Z");
    /* Flagged published, but its publish-from date is ahead: scheduled, not published. */
    expect(byRef[queued.itemRef].publication.code).toBe("scheduled");
    expect(byRef[queued.itemRef].actual).toEqual(expect.objectContaining({ scheduledAt: "2099-01-01T09:00:00.000Z", publishedAt: null }));
    expect(byRef[unknown.itemRef].publication.code).toBe("unknown");
    expect(byRef[expired.itemRef].publication.code).toBe("not_published");
    expect(byRef[expired.itemRef].actual.publishedAt).toBeNull();
    expect(byRef[noAsset.itemRef].publication.code).toBe("no_linked_asset");
    expect(Object.values(byRef).filter((i) => i.publication.code === "published").map((i) => i.itemRef)).toEqual([live.itemRef]);

    /* The library goes away: nothing is claimed. */
    library.down = true;
    const blind = (await calendarOf("from=2026-10-01&to=2026-10-31&timeZone=Asia/Kolkata")).body;
    expect(blind.contentLibrary.code).toBe("unavailable");
    expect(blind.items.find((i) => i.itemRef === live.itemRef).publication.code).toBe("unavailable");
    expect(blind.items.find((i) => i.itemRef === live.itemRef).actual.publishedAt).toBeNull();

    /* The asset is removed from the library: said so, not hidden. */
    library.down = false;
    library.email = library.email.filter((r) => r.id !== 1);
    const gone = (await get(`/content-plan/items/${live.itemRef}`)).body.item;
    expect(gone.publication.code).toBe("asset_missing");
    expect(gone.asset.name).toBe("Live");
  });

  test("25. nothing is written outside GRAV: only content-library reads, and no publishing route exists", async () => {
    library.email = [{ id: 7, name: "E", isPublished: false }];
    const item = await readyItem({ assetLink: { kind: "email", contentId: "7" } });
    await act((await act(item, "submit")).body.item, "approve", { user: ADMIN });
    await calendarOf("from=2026-10-01&to=2026-10-31");
    expect(library.calls.length).toBeGreaterThan(0);
    expect(library.calls.every((c) => c.method === "GET")).toBe(true);

    const router = require("../../routes/CMS_Routes/Marketing/contentPlan");
    const routes = router.stack.filter((l) => l.route)
      .flatMap((l) => Object.keys(l.route.methods).map((m) => `${m} ${l.route.path}`)).sort();
    expect(routes).toEqual([
      "get /content-plan/calendar", "get /content-plan/items", "get /content-plan/items/:itemRef",
      "get /content-plan/owners", "patch /content-plan/items/:itemRef", "post /content-plan/items",
      "post /content-plan/items/:itemRef/actions",
    ]);
    expect(C.ACTION_CODES).not.toEqual(expect.arrayContaining(["publish"]));
    expect(C.ACTION_CODES.some((a) => /publish|schedule|send|activate/.test(a))).toBe(false);
    expect(C.STATE_CODES.some((s) => /publish|schedul|sent|live/.test(s))).toBe(false);

    /* The content library router is still read-only. */
    const content = require("../../routes/CMS_Routes/Marketing/contentInventory");
    const contentMethods = content.stack.filter((l) => l.route).flatMap((l) => Object.keys(l.route.methods));
    expect([...new Set(contentMethods)]).toEqual(["get"]);
  });
});

/* ═══ 8. THE CONTRACT ═════════════════════════════════════════════════════ */

describe("contract", () => {
  test("26. no database id, membership, email address or provider name in any response", async () => {
    library.email = [{ id: 44, name: "Launch", isPublished: true }];
    const plan = await planFor(A);
    const item = await readyItem({ campaignDraftId: plan.campaignDraftId, assetLink: { kind: "email", contentId: "44" } });
    const stored = await MarketingContentPlanItem.findOne({ itemRef: item.itemRef }).lean();
    const texts = [
      (await get(`/content-plan/items/${item.itemRef}`)).text,
      (await get("/content-plan/items")).text,
      (await calendarOf("from=2026-10-01&to=2026-10-31")).text,
    ];
    const forbidden = [
      String(stored._id), String(A), String(stored.owner.membershipId), String(stored.campaign.draftId),
      MARKETER.id, MARKETER.email, "\"_id\"", "companyId", "membershipId", "employeeRef", "idempotencyKey",
      "createFingerprint", "mautic", "Mautic", "google", "Google", "meta_ads", "\"email\":\"mo",
    ];
    for (const text of texts) {
      for (const f of forbidden) expect([f, text.includes(f)]).toEqual([f, false]);
    }
  });

  test("27. the vocabulary names every code a response can carry", async () => {
    const { vocabulary } = (await calendarOf("from=2026-10-01&to=2026-10-01")).body;
    expect(vocabulary.states.map((s) => s.code)).toEqual(C.STATE_CODES);
    expect(vocabulary.publication.map((s) => s.code)).toEqual(C.PUBLICATION_CODES);
    expect(vocabulary.actions.find((a) => a.code === "approve")).toEqual(expect.objectContaining({ who: "approver", from: ["in_review"], to: "approved" }));
    expect(vocabulary.contentTypes.filter((t) => t.linksToLibrary).map((t) => t.code)).toEqual(["email", "landing_page", "form"]);
    expect(vocabulary.states.find((s) => s.code === "approved").means).toMatch(/does not mean it has been scheduled or published/);
    expect(vocabulary.actionRefusals.map((r) => r.code)).toEqual(
      ["not_in_this_state", "approver_only", "marketing_only", "own_submission", "media_unavailable", "incomplete"],
    );
  });
});
