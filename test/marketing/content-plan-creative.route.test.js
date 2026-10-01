// test/marketing/content-plan-creative.route.test.js
//
// CREATIVE DRAFTS IN THE CONTENT PLANNER, OVER THE REAL ROUTES.
//
// ── WHAT THIS PINS ─────────────────────────────────────────────────────────
//   One idea carries a concept and several platform versions, and the versions
//   are not posts: no state, no date, no publication of their own.
//   Editing replaces the creative, keeps a version's identity when its
//   reference is sent back, and is frozen once the item is submitted.
//   An approval is of one exact creative. A stale revision or a creative the
//   approver did not read is refused, and the approval records what it
//   approved.
//   Images come only from this company's advertising image library. A foreign,
//   forged or withdrawn image is refused, a vanished one is reported as
//   missing, and no URL, path or bytes are accepted as though a file were
//   saved.
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

const crypto = require("crypto");
const express = require("express");
const mongoose = require("mongoose");

const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const { MarketingContentPlanItem } = require("../../models/CMS_Models/Marketing/MarketingContentPlanItem");
const { MarketingAdvertisingAsset } = require("../../models/CMS_Models/Marketing/MarketingAdvertisingAsset");
const assetIdentity = require("../../services/marketing/assets/assetIdentity");
const C = require("../../constants/marketingContentPlan");

const oid = () => new mongoose.Types.ObjectId().toString();
const MARKETER = { id: oid(), name: "Mo", role: "marketing", email: "mo@grav.in" };
const ADMIN = { id: oid(), name: "Ada", role: "admin", email: "ada@grav.in" };

let A; let B;
let server; let base;
let seq = 0;
const fresh = (p) => `${p}-${Date.now()}-${(seq += 1)}`;
const ENV_KEYS = ["MARKETING_CHANNEL_ID_SECRET", "MARKETING_COMPANY_ID"];
const saved = {};

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  const app = express();
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
  await SpCompanyMembership.create([
    { companyId: A, email: MARKETER.email, personName: "Mo Khan", employeeRef: oid() },
    { companyId: A, email: ADMIN.email, personName: "Ada Rao", employeeRef: oid() },
  ]);
});

/* ── AN IMAGE ALREADY IN A COMPANY'S LIBRARY ─────────────────────────────── */
const DRIVE_REF = "drive-file-abc123-never-published";
async function libraryImage(companyId, over = {}) {
  const doc = await MarketingAdvertisingAsset.create({
    companyId,
    assetGroupId: new mongoose.Types.ObjectId(),
    version: 1,
    mimeType: "image/jpeg",
    byteSize: 204800,
    width: 1080,
    height: 1080,
    sha256: crypto.randomBytes(32).toString("hex"),
    originalFileName: over.fileName || "winter-shoot.jpg",
    storageRef: DRIVE_REF,
    storageOrigin: "company_drive",
    uploadedBy: { id: new mongoose.Types.ObjectId(), name: "Mo" },
    state: over.state || "awaiting_review",
  });
  return {
    doc,
    assetId: assetIdentity.encodeAssetId({ companyId: String(companyId), assetId: String(doc._id) }),
  };
}

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
const act = (item, action, { user = MARKETER, reason, revision, creativeFingerprint } = {}) => post(
  `/content-plan/items/${item.itemRef}/actions`,
  {
    expectedRevision: revision ?? item.revision, action,
    ...(reason ? { reason } : {}),
    ...(creativeFingerprint !== undefined ? { creativeFingerprint } : {}),
  },
  { user },
);

const POST_ITEM = Object.freeze({
  title: "Winter range teaser",
  contentType: "social_post",
  channel: "social",
  brief: "Tease the winter range to hotel buyers.",
  ownerRef: "self",
  planned: { date: "2026-10-20", time: "11:00", timeZone: "Asia/Kolkata" },
});

const creativeWith = (imageId) => ({
  concept: "Staff in the new winter range, warm lobby light.",
  references: [{ kind: "note", text: "Use the lobby shots from the September shoot." }],
  variants: [
    {
      platform: "instagram", format: "single_image",
      caption: "Winter, tailored. See the new range.",
      callToAction: { type: "learn_more", text: "See the range" },
      references: imageId ? [{ kind: "image", assetId: imageId }] : [],
    },
    { platform: "linkedin", format: "text_only", caption: "Our winter hospitality range is here." },
  ],
});

async function createPost(over = {}, opts = {}) {
  const res = await post("/content-plan/items", { idempotencyKey: fresh("key-creative"), ...POST_ITEM, ...over }, opts);
  if (res.status !== 201) throw new Error(`create failed ${res.status} ${res.text}`);
  return res.body.item;
}

/* ═══ 1. THE DRAFT ════════════════════════════════════════════════════════ */

describe("creative draft", () => {
  test("1. one idea, a concept and two platform versions read back exactly", async () => {
    const image = await libraryImage(A);
    const item = await createPost({ creative: creativeWith(image.assetId) });

    expect(item.creative.concept).toBe("Staff in the new winter range, warm lobby light.");
    expect(item.creative.fingerprint).toMatch(/^cf1_[0-9a-f]{32}$/);
    expect(item.creative.references).toEqual([{
      kind: { code: "note", label: "Written reference" },
      text: "Use the lobby shots from the September shoot.",
      status: { code: "not_stored", label: "Not a stored file" },
    }]);
    const [insta, linked] = item.creative.variants;
    expect(insta.variantRef).toMatch(/^var_[0-9a-f]{12}$/);
    expect(linked.variantRef).toMatch(/^var_[0-9a-f]{12}$/);
    expect(insta.variantRef).not.toBe(linked.variantRef);
    expect(insta).toEqual({
      variantRef: insta.variantRef,
      platform: { code: "instagram", label: "Instagram" },
      format: { code: "single_image", label: "Single image" },
      caption: "Winter, tailored. See the new range.",
      callToAction: { code: "learn_more", label: "Learn more", text: "See the range" },
      references: [{
        kind: { code: "image", label: "Image from the advertising image library" },
        assetId: image.assetId,
        fileName: "winter-shoot.jpg",
        width: 1080,
        height: 1080,
        contentHash: image.doc.sha256,
        status: { code: "available", label: "In the advertising image library" },
        libraryState: { code: "awaiting_review", label: "Waiting for review" },
      }],
    });
    expect(linked.callToAction).toBeNull();
    expect(item.history[0].creativeFingerprint).toBe(item.creative.fingerprint);

    const text = (await get(`/content-plan/items/${item.itemRef}`)).text;
    for (const f of [DRIVE_REF, String(image.doc._id), "storageRef", "assetGroupId", "\"_id\""]) {
      expect([f, text.includes(f)]).toEqual([f, false]);
    }
  });

  test("2. versions are not posts: one calendar entry, no state, date or publication of their own", async () => {
    const item = await createPost({ creative: creativeWith(null) });
    const cal = (await get("/content-plan/calendar?from=2026-10-01&to=2026-10-31&timeZone=Asia/Kolkata")).body;
    expect(cal.items).toHaveLength(1);
    expect(cal.items[0].itemRef).toBe(item.itemRef);
    /* The calendar carries a summary, not the copy. */
    expect(cal.items[0].creative).toEqual({
      hasConcept: true, variantCount: 2,
      platforms: [{ code: "instagram", label: "Instagram" }, { code: "linkedin", label: "LinkedIn" }],
      fingerprint: item.creative.fingerprint,
    });
    expect(JSON.stringify(cal.items[0])).not.toContain("Winter, tailored");

    for (const v of item.creative.variants) {
      expect(Object.keys(v).sort()).toEqual(["callToAction", "caption", "format", "platform", "references", "variantRef"]);
    }
    for (const smuggled of ["state", "planned", "publishedAt", "scheduledAt"]) {
      const creative = creativeWith(null);
      creative.variants[0][smuggled] = smuggled === "planned" ? { date: "2026-10-21", timeZone: "Asia/Kolkata" } : "x";
      const res = await post("/content-plan/items", { idempotencyKey: fresh("key-s"), ...POST_ITEM, creative });
      expect([smuggled, res.status]).toEqual([smuggled, 400]);
    }
  });

  test("3. strict validation of the creative", async () => {
    const bad = [
      ["platform", (c) => { c.variants[0].platform = "tiktok_ads"; }],
      ["format", (c) => { c.variants[0].format = "hologram"; }],
      ["cta type", (c) => { c.variants[0].callToAction = { type: "buy_bitcoin" }; }],
      ["cta text length", (c) => { c.variants[0].callToAction = { type: "shop_now", text: "x".repeat(C.LIMITS.CTA_TEXT_MAX + 1) }; }],
      ["markup caption", (c) => { c.variants[0].caption = "<b>Winter</b>"; }],
      ["caption length", (c) => { c.variants[0].caption = "x".repeat(C.LIMITS.CAPTION_MAX + 1); }],
      ["too many versions", (c) => { c.variants = Array.from({ length: C.LIMITS.VARIANTS_MAX + 1 }, () => ({ platform: "x", format: "text_only", caption: "hi" })); }],
      ["unknown key", (c) => { c.mood = "warm"; }],
      ["made-up variantRef", (c) => { c.variants[0].variantRef = "var_000000000000"; }],
      ["reference kind", (c) => { c.references = [{ kind: "video", text: "x" }]; }],
      ["note without text", (c) => { c.references = [{ kind: "note" }]; }],
    ];
    for (const [why, mutate] of bad) {
      const creative = creativeWith(null);
      mutate(creative);
      const res = await post("/content-plan/items", { idempotencyKey: fresh("key-v"), ...POST_ITEM, creative });
      expect([why, res.status]).toEqual([why, 400]);
    }
    expect(await MarketingContentPlanItem.countDocuments({})).toBe(0);
  });
});

/* ═══ 2. EDITING ══════════════════════════════════════════════════════════ */

describe("editing", () => {
  test("4. a version keeps its identity when sent back; the rest is replaced", async () => {
    const item = await createPost({ creative: creativeWith(null) });
    const [insta] = item.creative.variants;

    const next = {
      concept: item.creative.concept,
      variants: [
        { variantRef: insta.variantRef, platform: "instagram", format: "carousel", caption: "Winter, tailored. Swipe for the range." },
        { platform: "facebook", format: "single_image", caption: "The winter range is in." },
      ],
    };
    const res = await patch(`/content-plan/items/${item.itemRef}`, { expectedRevision: 1, creative: next });
    expect(res.status).toBe(200);
    const edited = res.body.item;
    expect(edited.revision).toBe(2);
    expect(edited.creative.variants.map((v) => v.platform.code)).toEqual(["instagram", "facebook"]);
    expect(edited.creative.variants[0].variantRef).toBe(insta.variantRef);
    expect(edited.creative.variants[1].variantRef).not.toBe(item.creative.variants[1].variantRef);
    expect(edited.creative.fingerprint).not.toBe(item.creative.fingerprint);
    expect(edited.history.at(-1)).toEqual(expect.objectContaining({
      action: "edited", changedFields: ["creative"], creativeFingerprint: edited.creative.fingerprint,
    }));

    /* Sending the same creative back changes nothing. */
    const again = await patch(`/content-plan/items/${item.itemRef}`, {
      expectedRevision: 2,
      creative: {
        concept: edited.creative.concept,
        variants: edited.creative.variants.map((v) => ({
          variantRef: v.variantRef, platform: v.platform.code, format: v.format.code, caption: v.caption,
        })),
      },
    });
    expect(again.body.unchanged).toBe(true);
    expect(again.body.item.revision).toBe(2);

    /* A reference used twice, or a stale revision, is refused. */
    const twice = await patch(`/content-plan/items/${item.itemRef}`, {
      expectedRevision: 2,
      creative: { concept: "x", variants: [0, 1].map(() => ({ variantRef: insta.variantRef, platform: "instagram", format: "story", caption: "x" })) },
    });
    expect(twice.status).toBe(400);
    const stale = await patch(`/content-plan/items/${item.itemRef}`, { expectedRevision: 1, creative: null });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("CONTENT_PLAN_REVISION_CONFLICT");

    /* null clears it. */
    const cleared = await patch(`/content-plan/items/${item.itemRef}`, { expectedRevision: 2, creative: null });
    expect(cleared.body.item.creative).toBeNull();
  });

  test("5. a post cannot be submitted without a concept and copy for every version", async () => {
    const none = await createPost();
    const refused = await act(none, "submit");
    expect(refused.status).toBe(409);
    expect(refused.body.error.details.missing).toEqual(["creative"]);

    const creative = creativeWith(null);
    creative.variants[1].caption = "";
    const blank = await createPost({ creative });
    expect((await act(blank, "submit")).body.error.details.missing).toEqual(["creative"]);
    expect((await get(`/content-plan/items/${blank.itemRef}`)).body.item.viewerActions.submit.reason).toBe("incomplete");

    /* An email is not judged on a creative draft. */
    const email = await createPost({ contentType: "email", channel: "email" });
    expect((await act(email, "submit")).status).toBe(200);
  });

  test("6. once submitted the creative is frozen; notes stay open", async () => {
    const item = await createPost({ creative: creativeWith(null) });
    const inReview = (await act(item, "submit")).body.item;
    const frozen = await patch(`/content-plan/items/${item.itemRef}`, { expectedRevision: inReview.revision, creative: null });
    expect(frozen.status).toBe(409);
    expect(frozen.body.error.details.blockedFields).toEqual(["creative"]);
    const notes = await patch(`/content-plan/items/${item.itemRef}`, { expectedRevision: inReview.revision, notes: "Check the CTA." });
    expect(notes.status).toBe(200);
    expect(notes.body.item.creative.fingerprint).toBe(item.creative.fingerprint);
  });
});

/* ═══ 3. APPROVAL OF ONE EXACT CREATIVE ═══════════════════════════════════ */

describe("approval", () => {
  test("7. an approver who read an older creative is refused; the approval records what it approved", async () => {
    const item = await createPost({ creative: creativeWith(null) });
    const submitted = (await act(item, "submit")).body.item;
    /* What the approver opened. */
    const seen = (await get(`/content-plan/items/${item.itemRef}`, { user: ADMIN })).body.item;
    const seenFingerprint = seen.creative.fingerprint;

    /* Meanwhile the author withdraws, rewrites the copy and resubmits. */
    const withdrawn = (await act(submitted, "withdraw")).body.item;
    const creative = creativeWith(null);
    creative.variants = withdrawn.creative.variants.map((v) => ({
      variantRef: v.variantRef, platform: v.platform.code, format: v.format.code, caption: `${v.caption} Now 20% off.`,
    }));
    const rewritten = (await patch(`/content-plan/items/${item.itemRef}`, { expectedRevision: withdrawn.revision, creative })).body.item;
    const resubmitted = (await act(rewritten, "submit")).body.item;
    expect(resubmitted.creative.fingerprint).not.toBe(seenFingerprint);

    /* Approving what was seen is refused, by revision… */
    const byRevision = await act(seen, "approve", { user: ADMIN });
    expect(byRevision.status).toBe(409);
    expect(byRevision.body.error.code).toBe("CONTENT_PLAN_REVISION_CONFLICT");
    /* …and by creative, even at the current revision. */
    const byCreative = await act(resubmitted, "approve", { user: ADMIN, creativeFingerprint: seenFingerprint });
    expect(byCreative.status).toBe(409);
    expect(byCreative.body.error.details.field).toBe("creativeFingerprint");
    expect((await get(`/content-plan/items/${item.itemRef}`)).body.item.state.code).toBe("in_review");

    /* Approving what is actually there. */
    const ok = await act(resubmitted, "approve", { user: ADMIN, creativeFingerprint: resubmitted.creative.fingerprint });
    expect(ok.status).toBe(200);
    const approved = ok.body.item;
    expect(approved.approval).toEqual({
      revision: resubmitted.revision,
      creativeFingerprint: resubmitted.creative.fingerprint,
      matchesCurrentCreative: true,
      mediaIntact: true,
      valid: true,
      invalidBecause: [],
    });
    expect(approved.history.at(-1)).toEqual(expect.objectContaining({
      action: "approve", by: "Ada", creativeFingerprint: resubmitted.creative.fingerprint,
    }));

    /* Approved means frozen, and a note does not disturb what was approved. */
    expect((await patch(`/content-plan/items/${item.itemRef}`, { expectedRevision: approved.revision, creative: null })).status).toBe(409);
    const noted = (await patch(`/content-plan/items/${item.itemRef}`, { expectedRevision: approved.revision, notes: "Go." })).body.item;
    expect(noted.approval.matchesCurrentCreative).toBe(true);

    /* Reopening clears the approval and opens the creative again. */
    const reopened = (await act(noted, "reopen", { reason: "Price changed." })).body.item;
    expect(reopened.approval).toBeNull();
    expect(reopened.viewerActions.edit.fields).toContain("creative");

    /* A fingerprint belongs to an approval only. */
    expect((await act(reopened, "submit", { creativeFingerprint: reopened.creative.fingerprint })).status).toBe(400);
  });

  test("8. the approval pins the exact image bytes, not just the file name", async () => {
    const first = await libraryImage(A, { fileName: "hero.jpg" });
    const second = await libraryImage(A, { fileName: "hero.jpg" });
    const item = await createPost({ creative: creativeWith(first.assetId) });

    /* Same words, same versions, same file name — different picture. */
    const swapped = {
      concept: item.creative.concept,
      references: [{ kind: "note", text: item.creative.references[0].text }],
      variants: item.creative.variants.map((v, i) => ({
        variantRef: v.variantRef, platform: v.platform.code, format: v.format.code, caption: v.caption,
        ...(v.callToAction ? { callToAction: { type: v.callToAction.code, text: v.callToAction.text } } : {}),
        references: i === 0 ? [{ kind: "image", assetId: second.assetId }] : [],
      })),
    };
    const res = await patch(`/content-plan/items/${item.itemRef}`, { expectedRevision: 1, creative: swapped });
    expect(res.body.unchanged).toBe(false);
    expect(res.body.item.creative.variants[0].references[0].fileName).toBe("hero.jpg");
    expect(res.body.item.creative.fingerprint).not.toBe(item.creative.fingerprint);
  });
});

/* ═══ 4. MEDIA AND TENANCY ════════════════════════════════════════════════ */

describe("media references", () => {
  test("9. another company's, forged, made-up or withdrawn images are refused, and nothing is saved", async () => {
    const theirs = await libraryImage(B);
    const withdrawn = await libraryImage(A, { state: "revoked" });
    const forged = `${theirs.assetId.split(".").slice(0, 2).join(".")}.AAAAAAAAAAAAAAAAAAAAAA`;
    for (const [why, assetId] of [["foreign", theirs.assetId], ["forged", forged], ["garbage", "not-an-image"], ["withdrawn", withdrawn.assetId]]) {
      const res = await post("/content-plan/items", { idempotencyKey: fresh("key-m"), ...POST_ITEM, creative: creativeWith(assetId) });
      expect([why, res.status]).toEqual([why, 422]);
      expect(res.body.error.code).toBe("CONTENT_PLAN_LINK_NOT_FOUND");
      expect(res.body.error.details.field).toBe("creative.variants[0].references[0].assetId");
    }
    expect(await MarketingContentPlanItem.countDocuments({})).toBe(0);
  });

  test("10. no file, link or bytes are accepted as though they were saved", async () => {
    for (const pointer of [
      { kind: "image", url: "https://cdn.example/x.jpg" },
      { kind: "image", data: "iVBORw0KGgo=" },
      { kind: "image", base64: "iVBORw0KGgo=" },
      { kind: "note", path: "/Volumes/Share/x.psd" },
      { kind: "image", assetId: "x", storageRef: DRIVE_REF },
    ]) {
      const creative = creativeWith(null);
      creative.references = [pointer];
      const res = await post("/content-plan/items", { idempotencyKey: fresh("key-p"), ...POST_ITEM, creative });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/stores no files/);
    }
    const { vocabulary } = (await get("/content-plan/items")).body;
    expect(vocabulary.creative.mediaStore).toEqual({
      images: true, formats: ["JPEG", "PNG"], otherMedia: false, gap: C.MEDIA_STORE.gap,
    });
    expect(vocabulary.creative.referenceKinds.map((k) => k.code)).toEqual(["image", "media", "note"]);
  });

  test("11. an image that later disappears or is withdrawn is reported, not hidden", async () => {
    const image = await libraryImage(A);
    const item = await createPost({ creative: creativeWith(image.assetId) });

    await MarketingAdvertisingAsset.collection.updateOne({ _id: image.doc._id }, { $set: { state: "revoked" } });
    let ref = (await get(`/content-plan/items/${item.itemRef}`)).body.item.creative.variants[0].references[0];
    expect(ref.status.code).toBe("withdrawn");

    await MarketingAdvertisingAsset.collection.deleteOne({ _id: image.doc._id });
    ref = (await get(`/content-plan/items/${item.itemRef}`)).body.item.creative.variants[0].references[0];
    expect(ref.status.code).toBe("missing");
    expect(ref.assetId).toBeNull();
    /* What it was is still recorded, so somebody can find a replacement. */
    expect([ref.fileName, ref.contentHash]).toEqual(["winter-shoot.jpg", image.doc.sha256]);
  });

  test("12. another company cannot read, edit or approve the creative", async () => {
    const item = await createPost({ creative: creativeWith(null) });
    const b = { company: B, user: ADMIN };
    expect((await get(`/content-plan/items/${item.itemRef}`, b)).status).toBe(404);
    expect((await patch(`/content-plan/items/${item.itemRef}`, { expectedRevision: 1, creative: null }, b)).status).toBe(404);
    expect((await act(item, "approve", { user: ADMIN, revision: 1 })).status).toBe(409);
    expect((await post(`/content-plan/items/${item.itemRef}/actions`, { expectedRevision: 1, action: "submit" }, b)).status).toBe(404);
    expect((await get("/content-plan/items", b)).body.items).toEqual([]);
  });
});
