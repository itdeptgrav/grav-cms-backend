// services/marketing/contentPlan/creative.js
//
// THE CREATIVE DRAFT FOR A PLANNED ITEM: ONE CONCEPT, SEVERAL PLATFORM VERSIONS.
//
// ── A VERSION IS NOT A POST ────────────────────────────────────────────────
// Every version lives inside its item and shares the item's planned date,
// workflow state, approval and publication. None of them can be scheduled,
// approved or published on its own, because none of them has a state to hold
// that in.
//
// ── MEDIA IS REFERENCED, NEVER STORED HERE ─────────────────────────────────
// An image reference names a version already in the company's advertising
// image library, by that library's own signed, company-bound identifier. The
// reference is confirmed against the library when it is written, and the exact
// bytes it named (their hash) are recorded, so an approval can say which
// picture it approved. The planner accepts no URL, no path and no upload: it
// has nowhere to keep a file, and it does not pretend to.
"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");

const { fail } = require("../../storePurchase/errors");
const { MarketingAdvertisingAsset } = require("../../../models/CMS_Models/Marketing/MarketingAdvertisingAsset");
const assetIdentity = require("../assets/assetIdentity");
const creativeMedia = require("../creativeMedia/creativeMedia.service");
const C = require("../../../constants/marketingContentPlan");
const { ASSET_STATES } = require("../../../constants/marketingAdvertisingAssets");

const str = (v) => String(v ?? "").trim();
const typeName = (v) => (v === null ? "null" : Array.isArray(v) ? "a list" : typeof v);

const MARKUP = /<\s*\/?\s*[a-z!][^>]*>/i;
/* Refused by name: each of these is somebody trying to hand the planner a file
   or a location, and a dropped field would let them believe it was kept. */
const POINTER_KEYS = ["url", "href", "src", "path", "file", "fileId", "data", "base64", "upload", "bytes", "driveId", "storageRef"];

function text(value, field, max, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw fail("VALIDATION", `${field} is required.`, { field });
    return "";
  }
  if (typeof value !== "string") throw fail("VALIDATION", `${field} must be text, not ${typeName(value)}.`, { field });
  const v = value.trim();
  if (required && !v) throw fail("VALIDATION", `${field} cannot be empty.`, { field });
  if (v.length > max) throw fail("VALIDATION", `${field} may be at most ${max} characters.`, { field, max });
  if (MARKUP.test(v)) throw fail("VALIDATION", `${field} is plain text.`, { field });
  return v;
}

function object(value, field, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw fail("VALIDATION", `${field} must be an object.`, { field });
  }
  const pointers = Object.keys(value).filter((k) => POINTER_KEYS.includes(k));
  if (pointers.length) {
    throw fail("VALIDATION",
      `${field} cannot carry ${pointers.join(", ")}. The planner stores no files and follows no links: reference an image already in the advertising image library, or describe the visual in a note.`,
      { field, refused: pointers });
  }
  const unknown = Object.keys(value).filter((k) => !allowed.includes(k));
  if (unknown.length) {
    throw fail("VALIDATION", `${field} accepts ${allowed.join(", ")}. ${unknown.join(", ")} is not part of it.`, { field, unknown });
  }
  return value;
}

function list(value, field, max) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw fail("VALIDATION", `${field} must be a list.`, { field });
  if (value.length > max) throw fail("VALIDATION", `${field} may hold at most ${max} entries.`, { field, max });
  return value;
}

function oneOf(value, allowed, field) {
  if (typeof value !== "string" || !allowed.includes(value.trim())) {
    throw fail("VALIDATION", `${field} must be one of: ${allowed.join(", ")}.`, { field, allowed });
  }
  return value.trim();
}

const newVariantRef = () => `var_${crypto.randomBytes(6).toString("hex")}`;

/* ── READING A REFERENCE ────────────────────────────────────────────────── */

function readReferenceShape(raw, field) {
  const ref = object(raw, field, ["kind", "assetId", "mediaRef", "text"]);
  const kind = oneOf(ref.kind, C.REFERENCE_KIND_CODES, `${field}.kind`);
  const only = (allowed) => {
    const extra = ["assetId", "mediaRef", "text"].filter((k) => k !== allowed && ref[k] !== undefined);
    if (extra.length) throw fail("VALIDATION", `${field}: a ${kind} reference has no ${extra.join(", ")}.`, { field });
  };
  if (kind === "note") {
    only("text");
    return { kind, text: text(ref.text, `${field}.text`, C.LIMITS.REFERENCE_NOTE_MAX, { required: true }) };
  }
  if (kind === "media") {
    only("mediaRef");
    if (typeof ref.mediaRef !== "string" || !ref.mediaRef.trim() || ref.mediaRef.length > 80) {
      throw fail("VALIDATION", `${field}.mediaRef must be a version reference from the creative media library.`, { field: `${field}.mediaRef` });
    }
    return { kind, token: ref.mediaRef.trim(), field };
  }
  only("assetId");
  if (typeof ref.assetId !== "string" || !ref.assetId.trim() || ref.assetId.length > 400) {
    throw fail("VALIDATION", `${field}.assetId must be an image identifier from the advertising image library.`, { field: `${field}.assetId` });
  }
  return { kind, token: ref.assetId.trim(), field };
}

/** Every image reference, confirmed in this company's library. */
async function confirmImages(company, refs, env) {
  const missing = (field) => fail("CONTENT_PLAN_LINK_NOT_FOUND",
    "That image is not in this company's advertising image library.", { field: `${field}.assetId` });

  const ids = [];
  for (const r of refs) {
    try {
      const { assetId } = assetIdentity.decodeAssetId(r.token, { companyId: String(company) }, env);
      if (!mongoose.Types.ObjectId.isValid(assetId)) throw missing(r.field);
      r.internal = assetId;
      ids.push(assetId);
    } catch (err) {
      if (err?.code === "CONTENT_PLAN_LINK_NOT_FOUND") throw err;
      throw missing(r.field);
    }
  }
  const docs = ids.length
    ? await MarketingAdvertisingAsset.find({ companyId: company, _id: { $in: ids } })
      .select("sha256 originalFileName width height state").lean()
    : [];
  const byId = new Map(docs.map((d) => [String(d._id), d]));
  for (const r of refs) {
    const doc = byId.get(String(r.internal));
    if (!doc) throw missing(r.field);
    if (doc.state === "revoked") {
      throw fail("CONTENT_PLAN_LINK_NOT_FOUND",
        "That image was withdrawn from the library and cannot be used in anything new.", { field: `${r.field}.assetId` });
    }
    r.stored = {
      kind: "image",
      assetId: doc._id,
      sha256: doc.sha256,
      fileName: doc.originalFileName,
      width: doc.width,
      height: doc.height,
      text: "",
    };
  }
}

/** Every creative-media reference, confirmed in this company's library. */
async function confirmMedia(company, refs) {
  if (!refs.length) return;
  const found = await creativeMedia.forCreative(company, refs.map((r) => r.token));
  for (const r of refs) {
    const doc = found.get(r.token);
    if (!doc) {
      throw fail("CONTENT_PLAN_LINK_NOT_FOUND",
        "That file is not in this company's creative media library.", { field: `${r.field}.mediaRef` });
    }
    if (doc.state !== "available") {
      throw fail("CONTENT_PLAN_LINK_NOT_FOUND",
        "That file version was withdrawn and cannot be used in anything new.", { field: `${r.field}.mediaRef` });
    }
    r.stored = {
      kind: "media",
      assetId: null,
      mediaRef: doc.mediaRef,
      groupRef: doc.groupRef,
      version: doc.version,
      mimeType: doc.mimeType,
      sha256: doc.sha256,
      fileName: doc.originalFileName,
      width: doc.width,
      height: doc.height,
      text: "",
    };
  }
}

/**
 * The creative a write sends, as it will be stored — or a refusal.
 *
 * The whole creative is replaced on every write that carries it. A version
 * keeps its identity by sending back its `variantRef`; a version without one is
 * new; an existing version not sent back is removed.
 *
 * @param {object|null} raw
 * @param {object|null} existing the item's stored creative, for variantRef checks
 */
async function read(company, raw, { existing = null, env = process.env } = {}) {
  if (raw === null) return null;
  const input = object(raw, "creative", ["concept", "references", "variants"]);
  const concept = text(input.concept, "creative.concept", C.LIMITS.CONCEPT_MAX);

  const images = [];
  const files = [];
  const shape = (r, field) => {
    const out = readReferenceShape(r, field);
    if (out.kind === "image") images.push(out);
    if (out.kind === "media") files.push(out);
    return out;
  };

  const references = list(input.references, "creative.references", C.LIMITS.REFERENCES_MAX)
    .map((r, i) => shape(r, `creative.references[${i}]`));

  const known = new Set((existing?.variants || []).map((v) => v.variantRef));
  const seen = new Set();
  const variants = list(input.variants, "creative.variants", C.LIMITS.VARIANTS_MAX).map((v, i) => {
    const field = `creative.variants[${i}]`;
    const src = object(v, field, ["variantRef", "platform", "format", "caption", "callToAction", "references"]);
    let variantRef = null;
    if (src.variantRef !== undefined) {
      variantRef = str(src.variantRef);
      if (!known.has(variantRef)) {
        throw fail("VALIDATION", `${field}.variantRef is not a version of this item. Leave it out to add a new version.`,
          { field: `${field}.variantRef` });
      }
      if (seen.has(variantRef)) {
        throw fail("VALIDATION", `${field}.variantRef appears twice.`, { field: `${field}.variantRef` });
      }
      seen.add(variantRef);
    }
    let callToAction = null;
    if (src.callToAction !== undefined && src.callToAction !== null) {
      const cta = object(src.callToAction, `${field}.callToAction`, ["type", "text"]);
      callToAction = {
        type: oneOf(cta.type, C.CALL_TO_ACTION_CODES, `${field}.callToAction.type`),
        text: text(cta.text, `${field}.callToAction.text`, C.LIMITS.CTA_TEXT_MAX),
      };
    }
    return {
      variantRef: variantRef || newVariantRef(),
      platform: oneOf(src.platform, C.PLATFORM_CODES, `${field}.platform`),
      format: oneOf(src.format, C.FORMAT_CODES, `${field}.format`),
      caption: text(src.caption, `${field}.caption`, C.LIMITS.CAPTION_MAX),
      callToAction,
      references: list(src.references, `${field}.references`, C.LIMITS.REFERENCES_MAX)
        .map((r, j) => shape(r, `${field}.references[${j}]`)),
    };
  });

  /* Every local check is done before the library is asked anything. */
  await confirmImages(company, images, env);
  await confirmMedia(company, files);

  const stored = (r) => (r.kind !== "note" ? r.stored : {
    kind: "note", assetId: null, sha256: "", fileName: "", width: null, height: null, text: r.text,
  });
  return {
    concept,
    references: references.map(stored),
    variants: variants.map((v) => ({ ...v, references: v.references.map(stored) })),
  };
}

/* ── THE FINGERPRINT OF EXACTLY WHAT WAS DRAFTED ────────────────────────────
   Covers the words, the platforms, the calls to action and the exact image
   bytes (by hash). Two creatives with the same fingerprint say and show the
   same thing. */
function fingerprint(creative) {
  if (!creative) return "";
  /* A library file is pinned by its exact version AND its bytes: naming a
     different version, even one with a similar name, is a different creative. */
  const ref = (r) => (r.kind === "image" ? ["image", r.sha256]
    : r.kind === "media" ? ["media", r.mediaRef, r.sha256]
      : ["note", r.text]);
  const canonical = {
    concept: creative.concept || "",
    references: (creative.references || []).map(ref),
    variants: (creative.variants || []).map((v) => [
      v.variantRef, v.platform, v.format, v.caption || "",
      v.callToAction ? [v.callToAction.type, v.callToAction.text || ""] : null,
      (v.references || []).map(ref),
    ]),
  };
  return `cf1_${crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 32)}`;
}

/** What is missing before an approver can judge it. */
function incomplete(creative) {
  if (!creative) return true;
  if (!str(creative.concept)) return true;
  if (!creative.variants?.length) return true;
  return creative.variants.some((v) => !str(v.caption));
}

/* ── READ SIDE ──────────────────────────────────────────────────────────── */

const allReferences = (c) => (c ? [...(c.references || []), ...(c.variants || []).flatMap((v) => v.references || [])] : []);

/** The current library state of every image an item's creative references. */
async function imageStates(company, creatives) {
  const ids = [];
  for (const c of creatives) {
    for (const r of allReferences(c)) {
      if (r.kind === "image" && r.assetId) ids.push(r.assetId);
    }
  }
  const docs = ids.length
    ? await MarketingAdvertisingAsset.find({ companyId: company, _id: { $in: ids } }).select("state").lean()
    : [];
  return new Map(docs.map((d) => [String(d._id), d.state]));
}

/** The current state of every file, of both libraries, a creative names. */
async function referenceStates(company, creatives) {
  const mediaRefs = creatives.flatMap((c) => allReferences(c)).filter((r) => r.kind === "media").map((r) => r.mediaRef);
  const [images, media] = await Promise.all([
    imageStates(company, creatives),
    creativeMedia.statesFor(company, mediaRefs),
  ]);
  return { images, media };
}

/* The status of one stored reference, now. */
function statusOf(r, states) {
  if (r.kind === "note") return "not_stored";
  if (r.kind === "image") {
    const state = states.images.get(String(r.assetId));
    return !state ? "missing" : state === "revoked" ? "withdrawn" : "available";
  }
  const doc = states.media.found.get(r.mediaRef);
  if (!doc) return "missing";
  if (doc.state === "withdrawn") return "withdrawn";
  return doc.integrityFailedAt ? "changed" : "available";
}

/**
 * Files a creative names that can no longer be shown. Any one of these means
 * the creative an approver saw cannot be seen any more, so an approval of it
 * is no longer good.
 */
function unavailableMedia(creative, states) {
  return allReferences(creative)
    .filter((r) => r.kind !== "note")
    .map((r) => ({ r, status: statusOf(r, states) }))
    .filter((x) => x.status !== "available")
    .map(({ r, status }) => ({
      kind: r.kind,
      reference: r.kind === "media" ? r.mediaRef : null,
      fileName: r.fileName,
      contentHash: r.sha256,
      status,
    }));
}

/* The words for a reference's status come from the library it lives in. */
const statusLabel = (kind, code) => {
  const hit = (C.REFERENCE_STATUS_BY_KIND[kind] || []).find((x) => x.code === code)
    || C.REFERENCE_STATUS.find((x) => x.code === code);
  return hit ? { code: hit.code, label: hit.label } : { code, label: code };
};

const label = (list, code) => {
  const hit = list.find((x) => x.code === code);
  return hit ? { code: hit.code, label: hit.label } : { code, label: code };
};

function presentReference(r, { company, states, env }) {
  if (r.kind === "note") {
    return { kind: label(C.REFERENCE_KINDS, "note"), text: r.text, status: statusLabel("note", "not_stored") };
  }
  if (r.kind === "media") {
    const status = statusOf(r, states);
    const latest = states.media.latestBy.get(r.groupRef) || null;
    return {
      kind: label(C.REFERENCE_KINDS, "media"),
      /* Always the version the draft named — identifiable even when withdrawn
         or gone, and never replaced by a newer one. */
      mediaRef: r.mediaRef,
      groupRef: r.groupRef,
      version: r.version,
      fileName: r.fileName,
      format: r.mimeType === "image/png" ? "PNG" : "JPEG",
      width: r.width,
      height: r.height,
      contentHash: r.sha256,
      status: statusLabel("media", status),
      /* Only an available version is shown, through the library's preview. */
      previewable: status === "available",
      newerVersionAvailable: Boolean(latest && latest > r.version),
    };
  }
  const state = states.images.get(String(r.assetId));
  const status = !state ? "missing" : state === "revoked" ? "withdrawn" : "available";
  let assetId = null;
  if (state) {
    try {
      assetId = assetIdentity.encodeAssetId({ companyId: String(company), assetId: String(r.assetId) }, env);
    } catch (_) {
      assetId = null;
    }
  }
  const libraryState = state ? ASSET_STATES.find((s) => s.code === state) : null;
  return {
    kind: label(C.REFERENCE_KINDS, "image"),
    /* The library's own public identifier, so a screen can show the picture
       through the library's existing preview route. Null when it is gone. */
    assetId,
    fileName: r.fileName,
    width: r.width,
    height: r.height,
    contentHash: r.sha256,
    status: statusLabel("image", status),
    libraryState: libraryState ? { code: libraryState.code, label: libraryState.label } : null,
  };
}

function present(creative, ctx) {
  if (!creative) return null;
  return {
    concept: creative.concept,
    references: (creative.references || []).map((r) => presentReference(r, ctx)),
    variants: (creative.variants || []).map((v) => ({
      variantRef: v.variantRef,
      platform: label(C.PLATFORMS, v.platform),
      format: label(C.FORMATS, v.format),
      caption: v.caption,
      callToAction: v.callToAction
        ? { ...label(C.CALLS_TO_ACTION, v.callToAction.type), text: v.callToAction.text }
        : null,
      references: (v.references || []).map((r) => presentReference(r, ctx)),
    })),
    fingerprint: fingerprint(creative),
  };
}

/** The list and calendar carry a summary, not the copy. */
function summary(creative) {
  if (!creative) return null;
  return {
    hasConcept: Boolean(str(creative.concept)),
    variantCount: (creative.variants || []).length,
    platforms: [...new Set((creative.variants || []).map((v) => v.platform))].map((p) => label(C.PLATFORMS, p)),
    fingerprint: fingerprint(creative),
  };
}

module.exports = { read, fingerprint, incomplete, imageStates, referenceStates, unavailableMedia, present, summary };
