// test/marketing/advertising-account-binding.route.test.js
//
// BINDING AN ADVERTISING ACCOUNT, OVER HTTP.
//
// ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
// The binding service accepted Meta's `businessId`, validated it, stored it and
// returned it. The HTTP route's allow-list held Google's four field names for
// every channel, so `businessId` came back as a 400 "not part of it" and a Meta
// binding could never carry the business its preflight reads.
//
// Every existing Meta binding test called `binding.bind()` directly, so the
// whole suite was green while the only path a browser can take was closed. That
// is the gap this file closes: these tests go through the router.
//
// ── AND THE SECOND HALF OF THE SAME BUG ────────────────────────────────────
// A single combined allow-list also let each channel accept the other's
// identifier. Storing a Meta business id on a Google binding is not untidy — it
// is a number no Google preflight will ever read, so the binding looks complete
// and is not, and somebody finds out when a campaign lands in a manager account
// they never chose.
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

const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const Binding = require("../../models/CMS_Models/Marketing/MarketingAdvertisingAccountBinding");
const metaAdsClient = require("../../services/marketing/channels/metaAdsClient");
const googleAdsClient = require("../../services/marketing/channels/googleAdsClient");

const MARKETER = { id: new mongoose.Types.ObjectId().toString(), name: "Mo", role: "marketing" };
const ADMIN = { id: new mongoose.Types.ObjectId().toString(), name: "Ada", role: "admin" };

const META_ACCOUNT = "act_1234567890";
const BUSINESS = "998877665544";
const GOOGLE_ACCOUNT = "123-456-7890";
const GOOGLE_NORMALISED = "1234567890";
const GOOGLE_MANAGER = "999-888-7777";

let app; let server; let base; let A; let B;

beforeAll(async () => {
  app = express();
  app.use((req, res, next) => {
    const c = String(req.headers["x-test-company"] || "");
    if (mongoose.Types.ObjectId.isValid(c)) req.__marketingCompanyId = new mongoose.Types.ObjectId(c);
    next();
  });
  app.use("/api/cms/marketing", require("../../routes/CMS_Routes/Marketing/campaignDeployment"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/marketing`;
});

afterAll(async () => { await new Promise((r) => server.close(r)); });

beforeEach(async () => {
  A = (await Acc_Company.create({ companyName: "GRAV Clothing", booksFromDate: new Date("2026-04-01") }))._id;
  B = (await Acc_Company.create({ companyName: "Other Co", booksFromDate: new Date("2026-04-01") }))._id;

  /* ── FAKE READS ONLY ─────────────────────────────────────────────────────
     Both clients answer about the account they were asked for, which is what
     the service requires before it will store a binding. Nothing here writes
     to a provider; `describeAccount` and `accessibleAccounts` are reads. */
  jest.spyOn(metaAdsClient, "accessibleAccounts").mockResolvedValue([META_ACCOUNT]);
  jest.spyOn(metaAdsClient, "describeAccount").mockImplementation(async ({ accountId, businessId }) => ({
    accountId,
    name: "GRAV Clothing Ads",
    currency: "INR",
    timeZone: "Asia/Kolkata",
    status: "ACTIVE",
    /* The provider echoes the business it was asked about, so a mismatch is
       detectable. */
    businessId: businessId || null,
    capabilities: [],
  }));
  jest.spyOn(googleAdsClient, "accessibleAccounts").mockResolvedValue([GOOGLE_NORMALISED]);
  jest.spyOn(googleAdsClient, "describeAccount").mockImplementation(async ({ customerId }) => ({
    accountId: customerId,
    name: "GRAV Clothing Search",
    currency: "INR",
    timeZone: "Asia/Kolkata",
    status: "ENABLED",
    capabilities: [],
  }));
});

afterEach(() => jest.restoreAllMocks());

const call = async (p, { user = ADMIN, method = "GET", body = null, company = null } = {}) => {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: {
      "x-test-user": JSON.stringify(user),
      "x-test-company": String(company || A),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json() };
};

/* ═══════════════════════════════════════════════════════════════════════════
   THE BUG THIS FILE WAS WRITTEN FOR
   ═══════════════════════════════════════════════════════════════════════════ */

describe("a Meta binding can carry its business, over HTTP", () => {
  test("businessId reaches the service and is stored", async () => {
    const res = await call("/advertising-accounts/meta_ads", {
      method: "POST",
      body: {
        externalAccountId: META_ACCOUNT,
        businessId: BUSINESS,
        externalAccountName: "GRAV Clothing Ads",
        note: "The account the agency set up.",
      },
    });

    expect(res.status).toBe(200);
    expect(res.body.binding.businessId).toBe(BUSINESS);

    /* ── AND IT IS ON THE ROW, NOT ONLY IN THE RESPONSE ─────────────────── */
    const row = await Binding.findOne({ companyId: A, channel: "meta_ads" }).lean();
    expect(row.businessId).toBe(BUSINESS);
    expect(row.externalAccountId).toBe(META_ACCOUNT);

    /* The provider was asked about that business, which is what makes the
       preflight's business comparison meaningful later. */
    expect(metaAdsClient.describeAccount).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: BUSINESS }),
    );
  });

  test("a Meta binding without a business is accepted, because the contract says optional", async () => {
    /* ── DELIBERATELY NOT REQUIRED ───────────────────────────────────────
       A personal advertising account legitimately belongs to no business, and
       Meta preflight already reports an absent business as `not_applicable`
       rather than failing — deployment works without it. Making the route
       require it would refuse bindings that deploy correctly today.

       What must NOT happen is a binding that silently looks business-verified
       when no business was given, so the stored value is empty rather than
       borrowed from anywhere. */
    const res = await call("/advertising-accounts/meta_ads", {
      method: "POST", body: { externalAccountId: META_ACCOUNT },
    });

    expect(res.status).toBe(200);
    expect(res.body.binding.businessId).toBeFalsy();

    const row = await Binding.findOne({ companyId: A, channel: "meta_ads" }).lean();
    expect(row.businessId || "").toBe("");
  });

  test("a business identifier that is not one is refused, and nothing is stored", async () => {
    for (const businessId of ["not-a-business", "12", "act_998877665544", "998877665544; DROP"]) {
      const res = await call("/advertising-accounts/meta_ads", {
        method: "POST", body: { externalAccountId: META_ACCOUNT, businessId },
      });
      expect(res.status).toBe(400);
      expect(await Binding.countDocuments({ companyId: A })).toBe(0);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   NEITHER CHANNEL ACCEPTS THE OTHER'S IDENTIFIER
   ═══════════════════════════════════════════════════════════════════════════ */

describe("each channel's fields are its own", () => {
  test("Google refuses businessId, and says whose it is", async () => {
    const res = await call("/advertising-accounts/google_ads", {
      method: "POST", body: { externalAccountId: GOOGLE_ACCOUNT, businessId: BUSINESS },
    });

    expect(res.status).toBe(400);
    /* ── REFUSED BY NAME, NOT IGNORED ────────────────────────────────────
       Silently dropping it would return 200 and leave somebody believing a
       business was recorded. */
    expect(JSON.stringify(res.body)).toMatch(/businessId/);
    expect(JSON.stringify(res.body)).toMatch(/meta ads/i);
    expect(await Binding.countDocuments({ companyId: A })).toBe(0);
  });

  test("Meta refuses loginAccountId, and says whose it is", async () => {
    const res = await call("/advertising-accounts/meta_ads", {
      method: "POST", body: { externalAccountId: META_ACCOUNT, loginAccountId: GOOGLE_MANAGER },
    });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/loginAccountId/);
    expect(JSON.stringify(res.body)).toMatch(/google ads/i);
    expect(await Binding.countDocuments({ companyId: A })).toBe(0);
  });

  test("Google still accepts its own manager account", async () => {
    const res = await call("/advertising-accounts/google_ads", {
      method: "POST",
      body: {
        externalAccountId: GOOGLE_ACCOUNT,
        loginAccountId: GOOGLE_MANAGER,
        externalAccountName: "GRAV Clothing Search",
        note: "Under the agency manager account.",
      },
    });

    expect(res.status).toBe(200);
    const row = await Binding.findOne({ companyId: A, channel: "google_ads" }).lean();
    expect(row.loginAccountId).toBe("9998887777");
    /* And carries no Meta field. */
    expect(row.businessId || "").toBe("");
  });

  test("the service refuses a cross-channel field even when called directly", async () => {
    /* ── THE ROUTE IS NOT THE ONLY DOOR ──────────────────────────────────
       The original bug was a route-only allow-list, so fixing it only at the
       route would leave an internal caller able to do the thing the route now
       refuses. */
    const binding = require("../../services/marketing/deployment/accountBinding.service");
    const actor = { id: new mongoose.Types.ObjectId(), name: "Ada", role: "admin" };

    await expect(binding.bind({
      companyId: A, channel: "google_ads",
      payload: { externalAccountId: GOOGLE_ACCOUNT, businessId: BUSINESS }, actor,
    })).rejects.toMatchObject({ code: "VALIDATION" });

    await expect(binding.bind({
      companyId: A, channel: "meta_ads",
      payload: { externalAccountId: META_ACCOUNT, loginAccountId: GOOGLE_MANAGER }, actor,
    })).rejects.toMatchObject({ code: "VALIDATION" });

    expect(await Binding.countDocuments({ companyId: A })).toBe(0);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   THE GUARANTEES THAT MUST SURVIVE THE CHANGE
   ═══════════════════════════════════════════════════════════════════════════ */

describe("nothing else moved", () => {
  test("credential-shaped names are still refused, on both channels", async () => {
    const names = ["accessToken", "refreshToken", "appSecret", "systemUserToken", "api_key", "password"];

    for (const channel of ["meta_ads", "google_ads"]) {
      const account = channel === "meta_ads" ? META_ACCOUNT : GOOGLE_ACCOUNT;
      for (const name of names) {
        const res = await call(`/advertising-accounts/${channel}`, {
          method: "POST", body: { externalAccountId: account, [name]: "EAAsomethinglongandsecret" },
        });
        expect(res.status).toBe(400);
        /* The refusal says where credentials live rather than "unknown field",
           so somebody does not simply retry under a different name. */
        expect(JSON.stringify(res.body)).not.toContain("EAAsomethinglongandsecret");
      }
    }
    expect(await Binding.countDocuments({ companyId: A })).toBe(0);
  });

  test("a credential-shaped VALUE is refused even under an allowed field name", async () => {
    /* `note` is allow-listed on both channels, which is exactly why the value
       check has to exist. */
    for (const [channel, account] of [["meta_ads", META_ACCOUNT], ["google_ads", GOOGLE_ACCOUNT]]) {
      const res = await call(`/advertising-accounts/${channel}`, {
        method: "POST",
        body: { externalAccountId: account, note: "1//0gXlongrefreshtokenvaluegoeshere" },
      });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).not.toContain("1//0gX");
    }
    expect(await Binding.countDocuments({ companyId: A })).toBe(0);
  });

  test("binding is still an administrator's decision", async () => {
    const res = await call("/advertising-accounts/meta_ads", {
      user: MARKETER, method: "POST",
      body: { externalAccountId: META_ACCOUNT, businessId: BUSINESS },
    });
    expect(res.status).toBe(403);
    expect(await Binding.countDocuments({ companyId: A })).toBe(0);

    /* But a marketer may still SEE which account a campaign would land in. */
    await call("/advertising-accounts/meta_ads", {
      method: "POST", body: { externalAccountId: META_ACCOUNT, businessId: BUSINESS },
    });
    const read = await call("/advertising-accounts/meta_ads", { user: MARKETER });
    expect(read.status).toBe(200);
    expect(read.body.bound).toBe(true);
    expect(read.body.mayBind).toBe(false);
  });

  test("unauthenticated is refused before anything else", async () => {
    const res = await fetch(`${base}/advertising-accounts/meta_ads`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ externalAccountId: META_ACCOUNT, businessId: BUSINESS }),
    });
    expect(res.status).toBe(401);
    expect(await Binding.countDocuments({})).toBe(0);
  });

  test("one company's binding is invisible and unreachable from another", async () => {
    await call("/advertising-accounts/meta_ads", {
      method: "POST", body: { externalAccountId: META_ACCOUNT, businessId: BUSINESS },
    });

    /* ── THE OTHER COMPANY SEES NOTHING ──────────────────────────────────
       A binding says which advertising account a company's money is spent in.
       Reading somebody else's is reading where their budget goes. */
    const theirs = await call("/advertising-accounts/meta_ads", { company: B });
    expect(theirs.status).toBe(200);
    expect(theirs.body.bound).toBe(false);
    expect(theirs.body.binding).toBeNull();

    /* And binding the same account for B does not touch A's row. */
    await call("/advertising-accounts/meta_ads", {
      company: B, method: "POST",
      body: { externalAccountId: META_ACCOUNT, businessId: "111122223333" },
    });

    const mine = await Binding.findOne({ companyId: A, channel: "meta_ads" }).lean();
    expect(mine.businessId).toBe(BUSINESS);
    expect(await Binding.countDocuments({ channel: "meta_ads" })).toBe(2);
  });

  test("an unknown channel is refused by the service, naming the ones that exist", async () => {
    const res = await call("/advertising-accounts/tiktok_ads", {
      method: "POST", body: { externalAccountId: "123456" },
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/google_ads|meta_ads/);
  });

  test("a Google account identifier is still refused on Meta, and the reverse", async () => {
    const wrongOnMeta = await call("/advertising-accounts/meta_ads", {
      method: "POST", body: { externalAccountId: GOOGLE_ACCOUNT },
    });
    expect(wrongOnMeta.status).toBe(400);

    const wrongOnGoogle = await call("/advertising-accounts/google_ads", {
      method: "POST", body: { externalAccountId: META_ACCOUNT },
    });
    expect(wrongOnGoogle.status).toBe(400);
    expect(await Binding.countDocuments({ companyId: A })).toBe(0);
  });

  test("no provider error text, endpoint or credential name reaches the browser", async () => {
    metaAdsClient.describeAccount.mockRejectedValue(
      new Error("GET https://graph.facebook.com/v21.0/act_1234567890 failed: 190 invalid OAuth access token"),
    );

    const res = await call("/advertising-accounts/meta_ads", {
      method: "POST", body: { externalAccountId: META_ACCOUNT, businessId: BUSINESS },
    });

    const flat = JSON.stringify(res.body);
    expect(flat).not.toMatch(/graph\.facebook\.com|OAuth|access token|190/);
    expect(flat).not.toMatch(/META_[A-Z_]+|FACEBOOK_[A-Z_]+/);
  });
});
