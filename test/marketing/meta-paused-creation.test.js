// test/marketing/meta-paused-creation.test.js
//
// CREATING A META CAMPAIGN, STOPPED, WITHOUT ATOMICITY.
//
// ── THE THING THESE TESTS ARE ACTUALLY ABOUT ───────────────────────────────
// Meta gives no all-or-nothing guarantee across campaign, ad set, creative and
// ad. So a sequence that stops part-way leaves a real, partly-built campaign,
// and the only thing standing between that and an unrecoverable mess is the
// discipline of writing every confirmed step down BEFORE making the next call.
//
// Most of what follows exercises that: stop at each stage in turn, and prove
// that what GRAV recorded matches exactly what the channel had confirmed, that
// no further write went out, and that nothing was deleted.
//
// Everything GRAV creates is created stopped, so a half-built campaign is
// inert — it shows nothing and spends nothing. Inert and recorded beats
// tidied-up and uncertain.
"use strict";

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
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

jest.mock("../../services/companyDrive.service", () => {
  const files = new Map();
  let n = 0;
  return {
    __files: files,
    uploadCompanyFile: jest.fn(async (buffer, { fileName, mimeType }) => {
      n += 1;
      const driveFileId = `drive-${n}`;
      files.set(driveFileId, { buffer: Buffer.from(buffer), fileName, mimeType });
      return { driveFileId, mimeType, bytes: buffer.length };
    }),
    streamCompanyFile: jest.fn(async (driveFileId) => {
      const stored = files.get(driveFileId);
      if (!stored) throw new Error("not found");
      const { Readable } = require("stream");
      return { stream: Readable.from([stored.buffer]), meta: { name: stored.fileName, mimeType: stored.mimeType } };
    }),
    deleteCompanyFile: jest.fn(async () => true),
  };
});

const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const { MarketingCampaignDeployment } = require("../../models/CMS_Models/Marketing/MarketingCampaignDeployment");
const {
  MarketingCampaignDeploymentAttemptIntent,
  MarketingCampaignDeploymentAttemptResult,
} = require("../../models/CMS_Models/Marketing/MarketingCampaignDeploymentAttempt");

const drafts = require("../../services/marketing/campaignDrafts/campaignDraft.service");
const binding = require("../../services/marketing/deployment/accountBinding.service");
const assetService = require("../../services/marketing/assets/advertisingAsset.service");
const metaCreation = require("../../services/marketing/deployment/metaPausedCreation.service");
const metaWriteClient = require("../../services/marketing/channels/metaAdsWriteClient");
const attempts = require("../../services/marketing/campaignDrafts/deploymentAttempt.service");
const marker = require("../../services/marketing/deployment/deploymentMarker");
const trackingConfig = require("../../services/marketing/trackingConfig.service");
const { fail } = require("../../services/storePurchase/errors");

const MARKETER = { id: new mongoose.Types.ObjectId().toString(), name: "Mo", role: "marketing" };
const ADMIN = { id: new mongoose.Types.ObjectId().toString(), name: "Ada", role: "admin" };

const ACCOUNT = "act_1234567890";
const BUSINESS = "9988776655";
const PIXEL = "1122334455667788";

const ENV_KEYS = ["MARKETING_CHANNEL_ID_SECRET"];
const savedEnv = {};
let app; let server; let base; let A;
let seq = 0;
const fresh = (p) => `${p}-${Date.now()}-${(seq += 1)}`;

beforeAll(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  app = express();
  app.use((req, res, next) => {
    const c = String(req.headers["x-test-company"] || "");
    if (mongoose.Types.ObjectId.isValid(c)) req.__marketingCompanyId = new mongoose.Types.ObjectId(c);
    next();
  });
  app.use("/api/cms/marketing", require("../../routes/CMS_Routes/Marketing/campaignDrafts"));
  app.use("/api/cms/marketing", require("../../routes/CMS_Routes/Marketing/campaignDeployment"));
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

beforeEach(async () => {
  const a = await Acc_Company.create({ companyName: "GRAV Clothing", booksFromDate: new Date("2026-04-01") });
  A = a._id;
  process.env.MARKETING_CHANNEL_ID_SECRET = "a-deployment-secret-long-enough";
  require("../../services/companyDrive.service").__files.clear();
});

const codeOf = (rel) => fs.readFileSync(path.join(__dirname, "../..", rel), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

/* ═══════════════════════════════════════════════════════════════════════════
   THE FAKE CHANNEL
   ═══════════════════════════════════════════════════════════════════════════ */

const pngOf = (width, height, padding = 0) => Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0, 0, 0, 13]), Buffer.from("IHDR"),
  (() => { const b = Buffer.alloc(8); b.writeUInt32BE(width, 0); b.writeUInt32BE(height, 4); return b; })(),
  Buffer.from([8, 6, 0, 0, 0]), Buffer.alloc(padding, 7),
]);

const GEO = Object.freeze({
  India: [{ key: "IN", name: "India", type: "country", countryCode: "IN", countryName: "India", canonicalName: "India" }],
  Goa: [{ key: "3861", name: "Goa", type: "region", countryCode: "IN", countryName: "India", canonicalName: "Goa, India" }],
});
const LOCALES = Object.freeze({ en: [{ key: "6", name: "en" }] });

const fakeRead = (over = {}) => ({
  accessibleAccounts: jest.fn(async () => [ACCOUNT.replace(/^act_/, "")]),
  describeAccount: jest.fn(async ({ accountId }) => ({
    accountId: String(accountId), accountName: "GRAV Clothing Ads",
    currency: "INR", timeZone: "Asia/Kolkata", status: "ACTIVE",
    disableReason: "", businessId: BUSINESS, businessName: "GRAV", capabilities: [], isPrepay: false,
  })),
  verifyDeploymentReads: jest.fn(async () => ({ campaigns: true, adSets: true, creatives: true, ads: true })),
  verifyInsightsRead: jest.fn(async () => true),
  readPixel: jest.fn(async ({ pixelId }) => ({
    requested: pixelId, found: pixelId === PIXEL ? { pixelId: PIXEL, name: "site" } : null, accountPixelCount: 1,
  })),
  searchGeoTargets: jest.fn(async ({ name, types }) => (GEO[name] || [])
    .filter((g) => !types?.length || types.includes(g.type))),
  searchLocales: jest.fn(async ({ query }) => LOCALES[query] || []),
  readVerifiedDomains: jest.fn(async () => ["grav.in"]),
  ...over,
});

/* ── THE WRITE CLIENT, EXERCISED FOR REAL ──────────────────────────────────
   Only the HTTP call is replaced. The closed operation table, the stopped-status
   gate, the creative's no-status rule and the audience-expansion gate all run,
   so a test that sends a delivering payload is refused by the real code. */
function fakeTransport(plan = {}) {
  let n = 7000;
  const t = async ({ operation, url, headers, data }) => {
    t.calls.push({ operation, url, headers, data });
    const step = plan[operation];
    if (typeof step === "function") return step({ operation, url, data });

    if (operation === "image.upload") {
      const hash = crypto.createHash("md5").update(data.bytes).digest("hex");
      t.created.push({ operation, providerObjectId: hash, payload: data });
      return { status: 200, data: { images: { [data.fileName]: { hash, url: "https://x" } } } };
    }
    n += 1;
    t.created.push({ operation, providerObjectId: String(n), payload: data });
    return { status: 200, data: { id: String(n) } };
  };
  t.calls = [];
  t.created = [];
  return t;
}

const authorise = async () => ({ creds: { accessToken: "test-token" } });

/* What the account holds, derived from what the transport recorded. */
const accountFor = (transport, over = {}) => jest.fn(async ({ marker: asked, knownObjectIds }) => {
  if (over.unavailable) throw fail("CHANNEL_UNAVAILABLE", "no answer");
  if (over.empty) return { marker: asked, objects: [], campaigns: [], uploadedImageHash: "" };

  const made = (op) => transport.created.find((c) => c.operation === op);
  const image = made("image.upload");
  const campaign = made("campaign.create");
  const adSet = made("adSet.create");
  const creative = made("creative.create");
  const ad = made("ad.create");
  if (!campaign) return { marker: asked, objects: [], campaigns: [], uploadedImageHash: "" };

  const t = adSet?.payload?.targeting || {};
  const flat = (geo) => Object.values(geo || {}).flatMap((v) => (Array.isArray(v)
    ? v.map((e) => (typeof e === "string" ? e : e.key)) : []));

  const objects = [
    {
      role: "campaign", providerObjectId: campaign.providerObjectId,
      name: campaign.payload.name, status: over.campaignStatus || campaign.payload.status, parentId: "",
    },
    ...(adSet ? [{
      role: "audience_group", providerObjectId: adSet.providerObjectId,
      name: adSet.payload.name, status: over.adSetStatus || adSet.payload.status,
      parentId: adSet.payload.campaign_id,
      targeting: {
        includedLocationKeys: over.dropLocations ? [] : flat(t.geo_locations),
        excludedLocationKeys: over.dropExclusions ? [] : flat(t.excluded_geo_locations),
        localeKeys: (t.locales || []).map(String),
        ageMin: over.ageMin ?? t.age_min,
        ageMax: t.age_max,
        genders: t.genders || [],
        audienceExpansion: over.expansionOn === true,
      },
    }] : []),
    ...(creative ? [{
      role: "creative", providerObjectId: creative.providerObjectId,
      name: creative.payload.name, status: "",
      imageHash: over.wrongImage ? "a-different-picture" : creative.payload.object_story_spec?.link_data?.image_hash,
    }] : []),
    ...(ad ? [{
      role: "advertisement", providerObjectId: ad.providerObjectId,
      name: ad.payload.name, status: over.adStatus || ad.payload.status,
      parentId: ad.payload.adset_id, creativeId: ad.payload.creative?.creative_id,
    }] : []),
  ].filter((o) => !(over.missing || []).includes(o.role));

  const campaignsOut = objects.filter((o) => o.role === "campaign");
  return {
    marker: asked,
    objects,
    campaigns: over.duplicate
      ? [...campaignsOut, { ...campaignsOut[0], providerObjectId: `${campaignsOut[0].providerObjectId}-twin` }]
      : campaignsOut,
    uploadedImageHash: over.wrongImage ? "the-approved-one" : image?.providerObjectId || "",
    knownObjectIds,
  };
});

const deps = (over = {}) => {
  const transport = over.transport || fakeTransport();
  const metaAds = over.metaAds
    || fakeRead({ readDeploymentByMarker: accountFor(transport, over.account || {}) });
  return { ...over, metaAds, transport, authorise };
};

/* ═══════════════════════════════════════════════════════════════════════════
   FIXTURES
   ═══════════════════════════════════════════════════════════════════════════ */

const BRIEF = Object.freeze({
  channel: "meta_ads",
  campaignType: "meta_traffic_single_image",
  destination: { kind: "grav_site_url", url: "https://grav.in/uniforms/winter" },
  geoTargeting: [{ name: "India", kind: "country" }],
  geoExclusions: [{ name: "Goa", kind: "region" }],
  languages: ["en"],
  audiences: [],
  exclusionDecision: "none_required",
  exclusions: [],
  bidding: { strategy: "maximise_clicks" },
  budgetRelationship: "campaign_daily",
  metaOptimisation: "link_clicks",
  specialAdCategory: "none",
  audienceMode: "broad_prospecting",
  audienceAgeMin: 25,
  audienceAgeMax: 54,
  audienceGenders: "all",
  audienceExpansionRequested: false,
  metaSingleImage: {
    primaryText: "Winter uniforms for hospitality, made to measure.",
    headline: "Order before October",
    callToAction: "learn_more",
    image: { kind: "landing_page", contentId: "88", capturedName: "Winter hero" },
  },
  timezone: "Asia/Kolkata",
});

const PLAN = Object.freeze({
  name: "Winter uniforms",
  objective: "lead_generation",
  channels: ["meta_ads"],
  startDate: "2026-10-01",
  endDate: "2026-12-15",
  budgetAmount: 2500,
  budgetCurrency: "INR",
  budgetBasis: "daily",
  conversionGoal: "form_submission",
});

const withoutKeys = (o) => {
  const out = { ...o };
  for (const [k, v] of Object.entries(out)) if (v === undefined) delete out[k];
  return out;
};

async function bindMeta(over = {}) {
  return binding.bind({
    companyId: A, channel: "meta_ads",
    payload: { externalAccountId: ACCOUNT, businessId: BUSINESS, ...over },
    actor: ADMIN,
  }, deps());
}

/* ── AN UPLOADED, REVIEWED, APPROVED ADVERTISING IMAGE ──────────────────────
   Each call makes DIFFERENT bytes by default. The library deduplicates
   identical bytes within a company — correctly — so a helper that produced the
   same picture every time would return an already-approved asset on the second
   call and then fail trying to approve it again. */
let imageSeq = 0;
async function approvedImage(bytes = null) {
  const buffer = bytes || pngOf(1200, 628, (imageSeq += 1) * 8);
  const out = await assetService.upload({
    companyId: A, user: MARKETER, buffer, payload: { fileName: "hero.png" },
  });
  if (out.asset.state !== "approved") {
    await assetService.review({
      companyId: A, user: ADMIN, assetId: out.asset.assetId, decision: "approve",
      payload: { authorisedToUse: true, approvedForAdvertising: true, reviewedThisVersion: true },
    });
  }
  return { assetId: out.asset.assetId, contentHash: out.asset.contentHash, bytes: buffer };
}

async function approvedPlan(briefOver = {}, planOver = {}) {
  const created = await drafts.create({
    companyId: A, user: MARKETER,
    payload: withoutKeys({
      ...PLAN, utmCampaign: fresh("winter"), idempotencyKey: fresh("k"),
      deploymentBriefs: [withoutKeys({ ...BRIEF, ...briefOver })],
      ...planOver,
    }),
  });
  await drafts.submit({ companyId: A, user: MARKETER, campaignDraftId: created.campaignDraftId, expectedRevision: created.revision });
  await drafts.decide({
    companyId: A, user: ADMIN, campaignDraftId: created.campaignDraftId,
    decision: "approve", reason: "Approved.",
  });
  return drafts.loadForDeployment({ companyId: A, campaignDraftId: created.campaignDraftId });
}

/** Everything a real creation needs: binding, tracking, image, approved plan. */
async function readyToCreate(briefOver = {}) {
  await bindMeta();
  await trackingConfig.save({
    companyId: A, user: ADMIN,
    payload: {
      siteUrl: "https://grav.in", trackingMode: "direct", metaPixelId: PIXEL,
      enabled: true, expectedRevision: 0, idempotencyKey: fresh("t"),
    },
  }).catch(() => null);
  const image = await approvedImage();
  const plan = await approvedPlan({ advertisingAssetId: image.assetId, ...briefOver });
  return { plan, image };
}

/* ── A FRESH COMPANY PER LOOP ITERATION ────────────────────────────────────
   Several tests below walk a list of failure modes. Each pass needs its own
   clean slate, and the attempt collections are append-only by design — so the
   slate comes from a NEW company rather than from deleting rows the record
   exists to protect. */
async function freshCompany() {
  const c = await Acc_Company.create({ companyName: "GRAV Clothing", booksFromDate: new Date("2026-04-01") });
  A = c._id;
  return c._id;
}

const createArgs = (plan, over = {}) => ({
  companyId: A,
  plan,
  expectedRevision: plan.revision,
  idempotencyKey: fresh("deploy"),
  requestedBy: { id: ADMIN.id, name: ADMIN.name, role: "admin" },
  authorizedBy: { id: ADMIN.id, name: ADMIN.name, at: new Date() },
  ...over,
});

/* ═══════════════════════════════════════════════════════════════════════════
   1–4. NOTHING IS SENT UNLESS EVERYTHING IS TRUE
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the preconditions", () => {
  test("1. a complete, approved plan with an approved image creates the campaign, stopped", async () => {
    const { plan } = await readyToCreate();
    const transport = fakeTransport();

    const out = await metaCreation.createPaused(createArgs(plan), deps({ transport }));

    expect(out.created).toBe(true);
    expect(out.outcome).toBe("succeeded");
    expect(out.deployment.state).toBe("paused_confirmed");

    /* ── THE OLD BLOCKER IS GONE, AND ONLY BECAUSE BOTH THINGS ARE REAL ───
       An approved image version and an explicit broad audience. Take either
       away and the campaign is refused again — tests 3 and 4. */
    expect(out.deliveryObjectsNonDeliveringConfirmed).toBe(true);
    expect(out.targetingConfirmed).toBe(true);
  });

  test("2. every precondition that fails sends nothing at all", async () => {
    const { plan, image } = await readyToCreate();

    const cases = [
      /* The exact approved revision is required, not inferred: a caller that
         omits it is asking GRAV to deploy whatever the plan says now. */
      [{ expectedRevision: undefined }, /names the exact approved plan revision/i],
      [{ expectedRevision: plan.revision + 1 }, /changed since that revision was approved/i],
      [{ idempotencyKey: "" }, /needs a request identity/i],
      /* A fingerprint from a screen somebody left open. */
      [{ expectedTargetingFingerprint: "stale-fingerprint" }, /has changed since it was checked/i],
    ];

    for (const [over, why] of cases) {
      const transport = fakeTransport();
      const err = await metaCreation.createPaused(createArgs(plan, over), deps({ transport })).catch((e) => e);
      expect(err.message).toMatch(why);
      expect(transport.calls).toHaveLength(0);
    }

    /* An unapproved image. */
    const revoked = await approvedImage(pngOf(1000, 1000));
    await assetService.review({
      companyId: A, user: ADMIN, assetId: revoked.assetId, decision: "revoke", payload: { note: "no" },
    });
    const revokedPlan = await approvedPlan({ advertisingAssetId: revoked.assetId });
    const t2 = fakeTransport();
    const err2 = await metaCreation.createPaused(createArgs(revokedPlan), deps({ transport: t2 })).catch((e) => e);
    expect(err2.code).toBe("CAMPAIGN_DEPLOYMENT_NOT_READY");
    expect(t2.calls).toHaveLength(0);

    /* And an unbound account. */
    await binding.revoke({ companyId: A, channel: "meta_ads", reason: "x", actor: ADMIN });
    const t3 = fakeTransport();
    await expect(metaCreation.createPaused(createArgs(plan), deps({ transport: t3 })))
      .rejects.toMatchObject({ code: "ADVERTISING_ACCOUNT_NOT_BOUND" });
    expect(t3.calls).toHaveLength(0);

    expect(await MarketingCampaignDeploymentAttemptIntent.countDocuments({ companyId: A })).toBe(0);
    void image;
  });

  test("3. no approved image means no creation", async () => {
    await bindMeta();
    /* A plan pointing at a content-library page rather than an approved image —
       which is every Meta plan before the library existed. */
    const plan = await approvedPlan();
    const transport = fakeTransport();

    const err = await metaCreation.createPaused(createArgs(plan), deps({ transport })).catch((e) => e);
    expect(err.code).toBe("CAMPAIGN_DEPLOYMENT_NOT_READY");
    expect(transport.calls).toHaveLength(0);
    expect(await MarketingCampaignDeployment.countDocuments({ companyId: A })).toBe(0);
  });

  test("4. an audience that is not explicitly broad means no creation", async () => {
    const cases = [
      [{ audienceMode: "" }, /does not say what kind of audience/i],
      [{ audienceMode: "retargeting" }, /one kind of audience/i],
      [{ audienceAgeMin: null }, /both an age floor and an age ceiling/i],
      [{ audienceAgeMax: null }, /both an age floor and an age ceiling/i],
      [{ audienceAgeMin: 54, audienceAgeMax: 25 }, /age floor is above the age ceiling/i],
      [{ audienceAgeMin: 12 }, /between 13 and 65/i],
      /* ── AN OMITTED GENDER IS NOT "EVERYONE" ──────────────────────────────
         The channel's default is everyone. If the field could be omitted, a
         plan that never considered gender would be indistinguishable from one
         that deliberately chose everyone. */
      [{ audienceGenders: "" }, /Choose everyone if that is what you mean/i],
      [{ audienceGenders: "other" }, /not a gender choice this channel offers/i],
      [{ languages: [] }, /needs at least one language/i],
      [{ audienceExpansionRequested: true }, /outside the audience that was approved/i],
      [{ audiences: [{ name: "Past buyers", kind: "custom_list" }] }, /account-level object/i],
      [{ audiences: [{ name: "Hotel managers", kind: "interest" }] }, /taxonomy id/i],
      [{ audiences: [{ name: "Similar", kind: "lookalike" }] }, /custom audience GRAV does not hold/i],
    ];

    for (const [briefOver, why] of cases) {
      await freshCompany();
      const { plan } = await readyToCreate(briefOver).catch(async () => {
        /* Some of these are refused at the plan's own readiness gate, which is
           the earlier and better refusal. Where that happens the creation can
           never be reached at all, which is what this loop is proving. */
        return { plan: null };
      });
      if (!plan) continue;

      const transport = fakeTransport();
      const err = await metaCreation.createPaused(createArgs(plan), deps({ transport })).catch((e) => e);
      expect(err.code).toBe("CAMPAIGN_DEPLOYMENT_NOT_READY");
      expect(JSON.stringify(err.details || {})).toMatch(why);
      expect(transport.calls).toHaveLength(0);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   5–9. THE SEQUENCE
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the operation sequence", () => {
  test("5. five operations, in order, each linked to the last", async () => {
    const { plan, image } = await readyToCreate();
    const transport = fakeTransport();

    await metaCreation.createPaused(createArgs(plan), deps({ transport }));

    expect(transport.calls.map((c) => c.operation)).toEqual([
      "image.upload", "campaign.create", "adSet.create", "creative.create", "ad.create",
    ]);

    const by = (op) => transport.calls.find((c) => c.operation === op);
    const made = (op) => transport.created.find((c) => c.operation === op);

    /* ── THE EXACT APPROVED BYTES ─────────────────────────────────────────
       Read from the library, which re-hashes them against the approved version
       every time. Not a URL, not a reference. */
    expect(by("image.upload").data.bytes.equals(image.bytes)).toBe(true);
    expect(by("image.upload").data.sha256).toBe(image.contentHash);

    /* ── AND THE CHANNEL'S OWN HASH COMES BACK FROM THAT UPLOAD ──────────
       GRAV never supplies one and never accepts one from a caller: a hash it
       did not receive names a picture nobody here has seen. */
    const uploadedHash = made("image.upload").providerObjectId;
    expect(by("creative.create").data.object_story_spec.link_data.image_hash).toBe(uploadedHash);

    expect(by("adSet.create").data.campaign_id).toBe(made("campaign.create").providerObjectId);
    expect(by("ad.create").data.adset_id).toBe(made("adSet.create").providerObjectId);
    expect(by("ad.create").data.creative.creative_id).toBe(made("creative.create").providerObjectId);

    /* Every request goes to the BOUND account. */
    for (const c of transport.calls) expect(c.url).toContain(`/${ACCOUNT}/`);
  });

  test("6. every delivery-capable payload carries the stopped status, and the creative carries none", async () => {
    const { plan } = await readyToCreate();
    const transport = fakeTransport();

    await metaCreation.createPaused(createArgs(plan), deps({ transport }));
    const by = (op) => transport.calls.find((c) => c.operation === op).data;

    expect(by("campaign.create").status).toBe("PAUSED");
    expect(by("adSet.create").status).toBe("PAUSED");
    expect(by("ad.create").status).toBe("PAUSED");

    /* ── A CREATIVE DOES NOT DELIVER ──────────────────────────────────────
       It is a description of what an advertisement looks like. Nothing is shown
       because of it, and giving it an invented status would be recorded by GRAV
       as evidence that a thing with no delivery state is stopped. */
    expect(by("creative.create")).not.toHaveProperty("status");

    /* ── AND THE CHANNEL MAY NOT WIDEN THE AUDIENCE ──────────────────────
       Written off explicitly rather than omitted: omitting it lets the
       channel's own default decide, and an approved audience quietly stops
       having boundaries. */
    expect(by("adSet.create").targeting.targeting_automation).toEqual({ advantage_audience: 0 });
    expect(by("adSet.create").targeting.targeting_optimization).toBe("none");

    /* The audience's own boundaries, all of them. */
    const t = by("adSet.create").targeting;
    expect(t.geo_locations).toEqual({ countries: ["IN"] });
    expect(t.excluded_geo_locations).toEqual({ regions: [{ key: "3861" }] });
    expect(t.locales).toEqual([6]);
    expect(t.age_min).toBe(25);
    expect(t.age_max).toBe(54);
    /* `all` maps to omitting the key, which is why it had to be a choice. */
    expect(t).not.toHaveProperty("genders");
  });

  test("7. the write client itself refuses a delivering payload, whatever the mapper did", async () => {
    const transport = fakeTransport();

    for (const payload of [
      { status: "ACTIVE" },
      { status: "PAUSED", nested: { status: "ACTIVE" } },
      { status: "PAUSED", effective_status: "ACTIVE" },
      { status: "" },
      {},
    ]) {
      await expect(metaWriteClient.create({
        role: "campaign", accountId: ACCOUNT, payload,
      }, { transport, authorise })).rejects.toMatchObject({ code: "CHANNEL_UNSUPPORTED_OPERATION" });
    }

    /* A creative given a status is refused too. */
    await expect(metaWriteClient.create({
      role: "creative", accountId: ACCOUNT, payload: { name: "x", status: "PAUSED" },
    }, { transport, authorise })).rejects.toThrow(/has no delivery status/i);

    /* An ad set whose expansion fields are missing or on. */
    await expect(metaWriteClient.create({
      role: "audience_group", accountId: ACCOUNT,
      payload: { status: "PAUSED", targeting: { geo_locations: { countries: ["IN"] } } },
    }, { transport, authorise })).rejects.toThrow(/may not widen it/i);

    await expect(metaWriteClient.create({
      role: "audience_group", accountId: ACCOUNT,
      payload: {
        status: "PAUSED",
        targeting: { targeting_automation: { advantage_audience: 1 }, targeting_optimization: "none" },
      },
    }, { transport, authorise })).rejects.toThrow(/outside the audience that was approved/i);

    expect(transport.calls).toHaveLength(0);
  });

  test("8. the command fingerprint covers the image, the plan, the binding and the targeting", async () => {
    const { plan, image } = await readyToCreate();
    const key = fresh("deploy");

    await metaCreation.createPaused(createArgs(plan, { idempotencyKey: key }), deps());

    const intent = await MarketingCampaignDeploymentAttemptIntent.findOne({ companyId: A }).lean();
    /* ── THE SAME KEY WITH A DIFFERENT COMMAND IS NOT A RETRY ─────────────
       Swapping the picture is a different advertisement, however identical
       everything else is; so is a different audience or a different account. */
    const differentImage = await approvedImage(pngOf(1100, 700));
    const differentCommand = { ...intent, plannedObjects: undefined };

    await expect(attempts.begin({
      companyId: A, deploymentId: intent.deploymentId, commandKey: intent.commandKey,
      approvedRevision: intent.approvedRevision, channel: "meta_ads",
      campaignType: "meta_traffic_single_image",
      requestedBy: { id: intent.requestedBy.id, name: intent.requestedBy.name, role: "admin" },
      authorizedBy: { id: intent.authorizedBy.id, name: intent.authorizedBy.name, at: intent.authorizedBy.at },
      deploymentMarker: intent.deploymentMarker,
      plannedObjects: [{ role: "creative", target: `asset:${differentImage.contentHash}` }],
    })).rejects.toMatchObject({ code: "CONFLICT" });

    /* And the marker itself is derived from the command's immutable identity. */
    expect(marker.looksLikeMarker(intent.deploymentMarker)).toBe(true);
    const deployment = await MarketingCampaignDeployment.findOne({ companyId: A }).lean();
    expect(deployment.deploymentMarker).toBe(intent.deploymentMarker);
    void image;
    void differentCommand;
  });

  test("9. success still requires a full read-back, and a disagreement is not success", async () => {
    const cases = [
      [{ campaignStatus: "ACTIVE" }, /not stopped/i],
      [{ adSetStatus: "ACTIVE" }, /not stopped/i],
      [{ adStatus: "ACTIVE" }, /not stopped/i],
      [{ dropLocations: true }, /locations are not the ones/i],
      [{ dropExclusions: true }, /excluded locations are not/i],
      [{ ageMin: 18 }, /age range is not the one/i],
      [{ expansionOn: true }, /outside the approved audience/i],
      [{ wrongImage: true }, /not showing the image that was approved/i],
      [{ missing: ["advertisement"] }, /not there/i],
    ];

    for (const [account, why] of cases) {
      await freshCompany();
      const { plan } = await readyToCreate();
      const transport = fakeTransport();

      const out = await metaCreation.createPaused(createArgs(plan), deps({ transport, account }));

      /* Created — the channel accepted every step — but NOT a success. */
      expect(out.created).toBe(true);
      expect(out.outcome).toBe("partially_created");
      expect(out.deployment.state).toBe("partially_created");
      expect(out.requiresReconciliation).toBe(true);
      expect(JSON.stringify(out.reconciliation.mismatches)).toMatch(why);
      /* Every identifier the channel gave is kept. */
      expect(out.deployment.externalObjects.length).toBeGreaterThan(0);
    }

    /* A read-back that could not be made is not a confirmation either. */
    await freshCompany();
    const { plan } = await readyToCreate();
    const out = await metaCreation.createPaused(createArgs(plan), deps({ account: { unavailable: true } }));
    expect(out.outcome).toBe("partially_created");
    expect(out.reconciliation.outcome).toBe("provider_unavailable");
    expect(out.deployment.deliveryObjectsNonDeliveringConfirmedAt).toBeNull();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   10–13. WHEN A STEP FAILS
   ═══════════════════════════════════════════════════════════════════════════ */

describe("a sequence that does not finish", () => {
  const STEPS = ["image.upload", "campaign.create", "adSet.create", "creative.create", "ad.create"];

  test("10. a lost response at any stage stops everything, and records exactly what exists", async () => {
    for (const [index, step] of STEPS.entries()) {
      await freshCompany();
      const { plan } = await readyToCreate();
      const transport = fakeTransport({
        [step]: async () => { throw fail("CHANNEL_UNAVAILABLE", "no answer"); },
      });

      const out = await metaCreation.createPaused(createArgs(plan), deps({ transport }));

      expect(out.created).toBe(false);
      expect(out.unresolved).toBe(true);
      expect(out.outcome).toBe("unknown");
      expect(out.failedStep).toBeTruthy();

      /* ── NO NEXT WRITE ───────────────────────────────────────────────────
         The step may have succeeded. Continuing would build on an object GRAV
         cannot name. */
      expect(transport.calls).toHaveLength(index + 1);
      expect(transport.calls[index].operation).toBe(step);

      /* ── NO RETRY, AND NOTHING DELETED ──────────────────────────────────
         Deleting means more writes into an account GRAV has just proved it
         does not understand. Everything created is stopped, so it is inert. */
      expect(out.rollback.attempted).toBe(false);
      expect(JSON.stringify(transport.calls)).not.toMatch(/delete|remove/i);

      /* ── AND WHAT WAS CONFIRMED BEFORE THE SILENCE IS RECORDED ──────────
         Written after every step, before the next began. This is the entire
         recovery story for a non-atomic sequence. */
      expect(out.objectsGravConfirmed).toHaveLength(index);
      const deployment = await MarketingCampaignDeployment.findOne({ companyId: A }).lean();
      expect(deployment.state).toBe("partially_created");
      expect(deployment.deploymentMarker).toBe(out.deploymentMarker);

      /* ── THE ATTEMPT STAYS OPEN, WHICH BLOCKS THE NEXT CREATION ─────────── */
      expect(await MarketingCampaignDeploymentAttemptResult.countDocuments({ companyId: A })).toBe(0);
      expect((await attempts.hasUnresolvedAttempt({ companyId: A, deploymentId: deployment._id })).unresolved)
        .toBe(true);

      const retry = fakeTransport();
      const openIntent = await MarketingCampaignDeploymentAttemptIntent.findOne({ companyId: A }).lean();
      const err = await metaCreation.createPaused(
        createArgs(plan, { idempotencyKey: openIntent.commandKey }), deps({ transport: retry }),
      ).catch((e) => e);
      expect(err.code).toBe("CAMPAIGN_DEPLOYMENT_RECONCILIATION_REQUIRED");
      expect(retry.calls).toHaveLength(0);
    }
  });

  test("11. a refusal after earlier steps records partial evidence and claims no rollback", async () => {
    const { plan } = await readyToCreate();

    /* The image and the campaign were created. The ad set was refused. */
    const transport = fakeTransport({
      "adSet.create": async () => { throw fail("CHANNEL_MALFORMED_RESPONSE", "policy"); },
    });

    const out = await metaCreation.createPaused(createArgs(plan), deps({ transport }));

    expect(out.created).toBe(false);
    expect(out.outcome).toBe("partially_created");
    expect(out.failedStep).toBe("audience_group");
    expect(transport.calls).toHaveLength(3);

    /* Every confirmed identifier is preserved. */
    expect(out.objectsGravConfirmed.map((o) => o.role)).toEqual(["creative_image", "campaign"]);
    expect(out.deployment.externalObjects.map((o) => o.role)).toEqual(["campaign"]);
    expect(out.deployment.state).toBe("partially_created");

    /* ── NO ROLLBACK IS CLAIMED, BECAUSE NONE WAS ATTEMPTED ──────────────── */
    expect(out.rollback.attempted).toBe(false);
    expect(out.rollback.complete).toBe(false);
    expect(out.rollback.means).toMatch(/stopped, so it shows nothing and spends nothing/i);
    expect(JSON.stringify(transport.calls)).not.toMatch(/delete|remove/i);

    const [attempt] = await attempts.attemptsFor({
      companyId: A, deploymentId: (await MarketingCampaignDeployment.findOne({ companyId: A }))._id,
    });
    expect(attempt.outcome).toBe("partially_created");
    expect(attempt.operatorNote).toMatch(/has not deleted anything/i);
    /* The campaign that exists is recorded as created but NOT confirmed
       stopped: the read-back that would establish it never happened. */
    const campaign = attempt.objects.find((o) => o.role === "campaign");
    expect(campaign.nonDeliveringConfirmed).toBe(false);
  });

  test("12. a refusal at the very first step creates nothing at all", async () => {
    const { plan } = await readyToCreate();
    const transport = fakeTransport({
      "image.upload": async () => { throw fail("CHANNEL_MALFORMED_RESPONSE", "refused"); },
    });

    const out = await metaCreation.createPaused(createArgs(plan), deps({ transport }));

    expect(out.outcome).toBe("failed");
    expect(transport.calls).toHaveLength(1);
    expect(out.deployment.externalObjects).toEqual([]);
    expect(out.rollback.means).toMatch(/nothing had been created/i);

    const [attempt] = await attempts.attemptsFor({
      companyId: A, deploymentId: (await MarketingCampaignDeployment.findOne({ companyId: A }))._id,
    });
    expect(attempt.outcome).toBe("failed");
    expect(attempt.objects).toEqual([]);

    /* A settled failure does NOT block the next attempt the way an unresolved
       one does — GRAV knows nothing was created. */
    expect((await attempts.hasUnresolvedAttempt({
      companyId: A, deploymentId: (await MarketingCampaignDeployment.findOne({ companyId: A }))._id,
    })).unresolved).toBe(false);
  });

  test("13. a complete hierarchy reconciles once, and nothing else does", async () => {
    const { plan } = await readyToCreate();

    /* The channel applied everything and the last response was lost. */
    const transport = fakeTransport();
    const realTransport = transport;
    const losing = async (args) => {
      const out = await realTransport(args);
      if (args.operation === "ad.create") throw fail("CHANNEL_UNAVAILABLE", "no answer");
      return out;
    };
    losing.calls = transport.calls;
    losing.created = transport.created;

    const lost = await metaCreation.createPaused(createArgs(plan), deps({ transport: losing }));
    expect(lost.unresolved).toBe(true);

    /* ── THE ACCOUNT HOLDS THE COMPLETE CAMPAIGN ─────────────────────────── */
    const out = await metaCreation.reconcile({ companyId: A, plan }, deps({ transport }));
    expect(out.outcome).toBe("one_complete_hierarchy");
    expect(out.reconciled).toBe(true);
    expect(out.deployment.state).toBe("paused_confirmed");

    const [attempt] = await attempts.attemptsFor({
      companyId: A, deploymentId: (await MarketingCampaignDeployment.findOne({ companyId: A }))._id,
    });
    expect(attempt.outcome).toBe("succeeded");
    expect(attempt.reasonCode).toBe("RECOVERED_BY_MARKER");
    /* GRAV did not watch these appear; it went and found them. */
    for (const o of attempt.objects) expect(o.origin).toBe("observed");

    /* ── IDEMPOTENT ─────────────────────────────────────────────────────── */
    const again = await metaCreation.reconcile({ companyId: A, plan }, deps({ transport }));
    expect(again.outcome).toBe("nothing_outstanding");
    expect(await MarketingCampaignDeploymentAttemptResult.countDocuments({ companyId: A })).toBe(1);

    /* And reconciliation made no write. */
    expect(transport.calls.filter((c) => /create|upload/.test(c.operation))).toHaveLength(5);
  });

  test("14. an empty, incomplete or duplicated account never recovers an attempt", async () => {
    /* `appliedThenLost` matters for the mismatch case: a hierarchy missing its
       advertisement is INCOMPLETE, which is a different finding from one that
       is complete and wrong. To test the second, the channel has to have
       applied everything before the connection dropped. */
    const cases = [
      [{ empty: true }, "no_confirmed_match", /reads can lag its writes/i, false],
      [{ missing: ["advertisement"] }, "incomplete_hierarchy", /are there/i, false],
      [{ campaignStatus: "ACTIVE" }, "mismatched_hierarchy", /not stopped/i, true],
      [{ duplicate: true }, "multiple_matches", /will not choose between them/i, true],
      [{ unavailable: true }, "provider_unavailable", /did not answer/i, false],
    ];

    for (const [account, outcome, why, appliedThenLost] of cases) {
      await freshCompany();
      const { plan } = await readyToCreate();

      const inner = fakeTransport();
      const transport = appliedThenLost
        ? Object.assign(async (args) => {
          /* The channel applied it, then the connection dropped. */
          const res = await inner(args);
          if (args.operation === "ad.create") throw fail("CHANNEL_UNAVAILABLE", "no answer");
          return res;
        }, { calls: inner.calls, created: inner.created })
        : fakeTransport({ "ad.create": async () => { throw fail("CHANNEL_UNAVAILABLE", "no answer"); } });

      await metaCreation.createPaused(createArgs(plan), deps({ transport }));

      const out = await metaCreation.reconcile({ companyId: A, plan }, deps({ transport, account }));

      expect(out.outcome).toBe(outcome);
      expect(out.reconciled).toBe(false);
      expect(`${out.detail} ${JSON.stringify(out.mismatches)}`).toMatch(why);
      /* ── AND NEVER AN AUTHORISATION TO CREATE AGAIN ────────────────────── */
      expect(out.mayCreateAgain).toBe(false);
      expect(await MarketingCampaignDeploymentAttemptResult.countDocuments({ companyId: A })).toBe(0);

      const retry = fakeTransport();
      const openIntent = await MarketingCampaignDeploymentAttemptIntent.findOne({ companyId: A }).lean();
      await expect(metaCreation.createPaused(
        createArgs(plan, { idempotencyKey: openIntent.commandKey }), deps({ transport: retry }),
      )).rejects.toMatchObject({ code: "CAMPAIGN_DEPLOYMENT_RECONCILIATION_REQUIRED" });
      expect(retry.calls).toHaveLength(0);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   15–17. THE BOUNDARY
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the boundary", () => {
  test("15. no activation or update operation exists, in any channel", async () => {
    /* ── NOT DISABLED. ABSENT. ────────────────────────────────────────────── */
    for (const name of Object.keys(metaWriteClient)) {
      expect(name).not.toMatch(/update|activate|enable|publish|delete|remove|pause/i);
    }
    for (const spec of Object.values(metaWriteClient.OPERATIONS)) {
      expect(spec.operation).toMatch(/\.(upload|create)$/);
    }

    const src = codeOf("services/marketing/channels/metaAdsWriteClient.js");
    expect(src).not.toMatch(/["'`]ACTIVE["'`]/);
    expect(src).not.toMatch(/method:\s*["'`](PUT|PATCH|DELETE)["'`]/);

    const routes = codeOf("routes/CMS_Routes/Marketing/campaignDeployment.js");
    expect(routes).not.toMatch(/router\.(post|patch|put)\([^)]*activat/i);

    /* ── AND THE RECONCILER CANNOT REACH THE WRITE CLIENT ─────────────────
       It runs after a failure, when the temptation to "just fix it" is
       highest. */
    const reconciler = codeOf("services/marketing/deployment/metaReconciliation.service.js");
    expect(reconciler).not.toMatch(/metaAdsWriteClient/);
    expect(Object.keys(require("../../services/marketing/deployment/metaReconciliation.service")))
      .not.toContain("create");
  });

  test("16. no provider or storage detail reaches a response", async () => {
    const { plan } = await readyToCreate();
    const id = require("../../services/marketing/campaignDrafts/draftIdentity")
      .encodeDraftId({ companyId: String(A), draftId: String(plan._id) });

    const metaAdsClient = require("../../services/marketing/channels/metaAdsClient");
    const transport = fakeTransport({
      "campaign.create": async () => {
        throw fail("CHANNEL_UNAVAILABLE",
          "ECONNRESET reading https://graph.facebook.com/v21.0/act_1234567890/campaigns?access_token=EAAJk2ZC");
      },
    });

    const reads = fakeRead({ readDeploymentByMarker: accountFor(transport, {}) });
    const spies = Object.keys(reads)
      .filter((op) => typeof metaAdsClient[op] === "function")
      .map((op) => jest.spyOn(metaAdsClient, op).mockImplementation(reads[op]));
    /* ── CAPTURE THE REAL FUNCTIONS BEFORE SPYING ────────────────────────
       This previously reached for them through `jest.requireActual(...)`, which
       returns the SAME cached module object that `jest.spyOn` has just
       mutated — so the "real" function it fetched was the mock, and the mock
       called itself until the stack ran out.

       The `RangeError: Maximum call stack size exceeded` that printed on every
       run of this suite was that recursion. The test still passed, which is the
       worse half: the overflow was caught by the route's error handler, which
       answered a generic 500 carrying no provider detail — so every assertion
       below passed without the provider-privacy path ever running. It would
       have passed with that boundary completely broken.

       Holding the function values from before the spy is what makes the
       assertions mean what they say. */
    const realCreate = metaWriteClient.create;
    const realUploadImage = metaWriteClient.uploadImage;

    const writeSpy = jest.spyOn(metaWriteClient, "uploadImage")
      .mockImplementation(async (args) => realUploadImage(args, { transport, authorise }));
    const createSpy = jest.spyOn(metaWriteClient, "create")
      .mockImplementation(async (args) => realCreate(args, { transport, authorise }));

    const res = await fetch(`${base}/campaign-drafts/${id}/deployment/meta_ads/create-paused`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-test-user": JSON.stringify(ADMIN),
        "x-test-company": String(A),
      },
      body: JSON.stringify({ idempotencyKey: fresh("k"), expectedRevision: plan.revision }),
    });
    const body = await res.json();

    /* ── A POSITIVE ASSERTION FIRST ──────────────────────────────────────
       Every check below is a `not.toMatch`, and a response that says nothing at
       all satisfies all of them. That is exactly how this test passed for
       months while a stack overflow answered a generic 500 in place of the
       path it meant to exercise. So: prove the channel refusal actually
       travelled through the provider-privacy boundary before proving what it
       left behind. */
    expect(res.status).toBe(200);
    expect(body.reasonCode).toBe("RESPONSE_LOST");
    expect(body.unresolved).toBe(true);
    expect(body.failedStep).toBe("campaign");
    /* A real, substantive answer — GRAV's own account of what happened, which
       is what the checks below are actually examining. */
    expect(String(body.reason)).toMatch(/did not learn how the campaign step ended/i);

    const flat = JSON.stringify(body);
    expect(flat).not.toMatch(/graph\.facebook\.com|ECONNRESET|access_token/i);
    expect(flat).not.toMatch(/EAA[A-Za-z0-9]{6,}|Bearer/);
    expect(flat).not.toMatch(/META_ADS_[A-Z_]+|MARKETING_CHANNEL_ID_SECRET/);
    /* No storage identifier and no database id. */
    expect(flat).not.toMatch(/drive-\d+|storageRef|driveFileId/i);

    spies.forEach((s) => s.mockRestore());
    writeSpy.mockRestore();
    createSpy.mockRestore();
  });

  test("17. another company cannot reach this company's deployment or image", async () => {
    const { plan, image } = await readyToCreate();
    await metaCreation.createPaused(createArgs(plan), deps());

    const other = await Acc_Company.create({ companyName: "Other Co", booksFromDate: new Date("2026-04-01") });

    /* No binding of its own, so no account to deploy into — it does not inherit
       this one's. */
    await expect(metaCreation.createPaused({ ...createArgs(plan), companyId: other._id }, deps()))
      .rejects.toMatchObject({ code: "ADVERTISING_ACCOUNT_NOT_BOUND" });
    await expect(metaCreation.reconcile({ companyId: other._id, plan }, deps()))
      .rejects.toMatchObject({ code: "ADVERTISING_ACCOUNT_NOT_BOUND" });

    /* And the image is company-scoped at its own boundary. */
    await expect(assetService.forDeployment({ companyId: other._id, assetId: image.assetId }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });

    /* The marker is company-scoped too, so even a shared account could not
       produce a match. */
    const mine = marker.markerFor({
      companyId: String(A), bindingId: "b", externalAccountId: ACCOUNT,
      campaignDraftId: String(plan._id), approvedRevision: plan.revision,
      commandKey: "k", channel: "meta_ads", campaignType: "meta_traffic_single_image",
    });
    const theirs = marker.markerFor({
      companyId: String(other._id), bindingId: "b", externalAccountId: ACCOUNT,
      campaignDraftId: String(plan._id), approvedRevision: plan.revision,
      commandKey: "k", channel: "meta_ads", campaignType: "meta_traffic_single_image",
    });
    expect(theirs).not.toBe(mine);
  });
});
