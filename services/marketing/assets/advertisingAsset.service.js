// services/marketing/assets/advertisingAsset.service.js
//
// THE ADVERTISING IMAGE LIBRARY: BYTES IN, A PERSON'S DECISION, THEN USABLE.
//
// ── TWO FACTS, AND THEY ARE INDEPENDENT ────────────────────────────────────
// A file arriving in GRAV means somebody had it on their laptop. It does not
// mean the company owns it, that anyone looked at it, or that it may appear in
// a paid advertisement with the company's name beside it. So uploading stores
// bytes and nothing else; deployability comes from a separate, deliberate
// decision by somebody other than the uploader, about an exact set of bytes.
//
// ── EVERYTHING THAT MATTERS IS READ FROM THE BYTES ─────────────────────────
// Format, dimensions and hash all come from the file's own headers and content.
// Not from the filename, not from the request's `Content-Type`, and never from
// a caller-supplied field — there is no field to supply them in.
//
// ── AND A POINTER IS NOT AN ASSET ──────────────────────────────────────────
// A URL, a Drive id, a link to an email attachment, an advertising channel's
// own image hash: each is somebody offering a reference instead of a file. GRAV
// cannot hash a pointer, cannot size it, cannot prove it will resolve tomorrow
// and cannot prove the company may advertise with whatever is on the other end.
// Refused by name, so the message says what the problem actually is.
//
// ── STORAGE IS THE EXISTING COMPANY DRIVE ──────────────────────────────────
// `companyDrive.service.js` already uploads private files to the company's own
// Drive and streams them back through an authenticated GRAV route. This uses
// it. Building a second general-purpose file system for advertising images
// would mean two places to secure, two to back up and two to get wrong.
"use strict";

const mongoose = require("mongoose");

const { fail } = require("../../storePurchase/errors");
const companyDrive = require("../../companyDrive.service");
const imageBytes = require("./imageBytes");
const identity = require("./assetIdentity");
const {
  MarketingAdvertisingAsset,
  MarketingAdvertisingAssetHistory,
} = require("../../../models/CMS_Models/Marketing/MarketingAdvertisingAsset");
const {
  ASSET_STATES,
  ASSET_TRANSITIONS,
  DEPLOYABLE_STATES,
  APPROVAL_ASSERTIONS,
  APPROVAL_ASSERTION_CODES,
  ASSET_LIMITS,
  REFUSED_SOURCES,
  REFUSED_FIELD_HINTS,
  UPLOAD_FIELDS,
  APPROVAL_FIELDS,
  ASSET_CODES: C,
} = require("../../../constants/marketingAdvertisingAssets");

const str = (v) => String(v ?? "").trim();

const STATE_BY_CODE = Object.fromEntries(ASSET_STATES.map((s) => [s.code, s]));
const SOURCE_BY_CODE = Object.fromEntries(REFUSED_SOURCES.map((s) => [s.code, s]));

/* ── WHO MAY DECIDE ─────────────────────────────────────────────────────────
   The same rule the campaign plan uses: marketing writes, an administrator or
   the CEO decides. Written out rather than imported because the plan service's
   copy is private to it; the shape is identical on purpose, so a reader of
   either recognises the other. */
const isReviewer = (user) => Boolean(user?.isAdmin) || ["admin", "ceo"].includes(str(user?.role));

function actorFrom(user) {
  const raw = str(user?.id);
  if (!mongoose.Types.ObjectId.isValid(raw)) {
    throw fail("CAMPAIGN_DRAFT_ACTOR_UNVERIFIED",
      "GRAV records who uploaded and who approved an advertising image, so this needs a signed-in identity it can attribute the decision to.",
      { field: "actor" });
  }
  return {
    id: new mongoose.Types.ObjectId(raw),
    name: str(user?.name),
    role: str(user?.role),
    at: new Date(),
  };
}

function assertCompany(companyId) {
  const raw = str(companyId);
  if (!mongoose.Types.ObjectId.isValid(raw)) {
    throw fail("VALIDATION", "An advertising image belongs to a company.", { field: "companyId" });
  }
  return new mongoose.Types.ObjectId(raw);
}

/* ── A POINTER, BY FIELD NAME ───────────────────────────────────────────────
   Evaluated over the caller's OWN keys so an extra one is noticed rather than
   ignored. A dropped field returns 200 and the sender believes it was used. */
function assertNoPointer(payload, allowed) {
  const obj = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  for (const key of Object.keys(obj)) {
    const flat = key.toLowerCase().replace(/[^a-z]/g, "");
    if (REFUSED_FIELD_HINTS.some((hint) => flat.includes(hint))) {
      /* Which KIND of pointer, so the refusal explains itself. */
      const guess = flat.includes("drive") || flat.includes("storage") ? "drive_identifier"
        : flat.includes("imagehash") || flat.includes("hash") ? "provider_image_hash"
          : flat.includes("attachment") || flat.includes("contentid") ? "email_attachment_url"
            : "remote_url";
      const spec = SOURCE_BY_CODE[guess];
      throw fail("VALIDATION",
        `${spec.label} cannot be used here. ${spec.why}`,
        { field: key, code: C.POINTER_NOT_BYTES });
    }
    if (!allowed.includes(key)) {
      throw fail("VALIDATION", `This accepts only: ${allowed.join(", ")}.`, { field: key });
    }
  }
  return obj;
}

/* Display text, never a path and never used to decide anything. Control
   characters are stripped because a filename is rendered in a browser and
   written into a storage object's name, and neither should carry them. */
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f]/g;

const safeFileName = (name) => str(name)
  .replace(/[\\/]/g, " ")
  .replace(CONTROL_CHARACTERS, "")
  .slice(0, ASSET_LIMITS.FILE_NAME_MAX) || "image";

async function appendHistory({ companyId, assetId, action, fromState, toState, actor, reason, assertions, sha256 }) {
  await MarketingAdvertisingAssetHistory.create({
    companyId,
    assetId,
    at: new Date(),
    action,
    fromState: fromState || "",
    toState: toState || "",
    actor,
    reason: str(reason).slice(0, ASSET_LIMITS.REASON_MAX),
    assertions: assertions || null,
    sha256: str(sha256),
  });
}

/**
 * Store one uploaded image.
 *
 * @param {object}   args
 * @param {ObjectId} args.companyId
 * @param {object}   args.user
 * @param {Buffer}   args.buffer   the exact bytes that arrived
 * @param {object}   args.payload  `{ fileName?, note? }` — nothing else
 */
async function upload({ companyId, user, buffer, payload = {} }, deps = {}) {
  const company = assertCompany(companyId);
  const actor = actorFrom(user);
  const fields = assertNoPointer(payload, UPLOAD_FIELDS);

  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw fail("VALIDATION", "No image file arrived with that upload.", { field: "file", code: C.NO_FILE });
  }

  /* ── THE SIZE CEILING IS ALSO ENFORCED AT THE ROUTE ─────────────────────
     There it stops the bytes mid-flight; here it catches a caller that reached
     the service another way. Both matter: the route saves the bandwidth, this
     saves the storage write. */
  if (buffer.length > ASSET_LIMITS.MAX_BYTES) {
    throw fail("VALIDATION",
      `That image is larger than ${Math.round(ASSET_LIMITS.MAX_BYTES / (1024 * 1024))}MB. Export a smaller version — an advertising image is recompressed by the channel anyway.`,
      { field: "file", code: C.TOO_LARGE });
  }

  /* ── WHAT IT ACTUALLY IS ────────────────────────────────────────────────── */
  const read = imageBytes.inspect(buffer);
  if (!read.ok) {
    throw fail("VALIDATION", read.why, {
      field: "file",
      code: read.code === "unreadable" ? C.SIGNATURE_MISMATCH : C.UNSUPPORTED_FORMAT,
      format: read.label || null,
    });
  }

  if (read.width < ASSET_LIMITS.MIN_WIDTH || read.height < ASSET_LIMITS.MIN_HEIGHT) {
    throw fail("VALIDATION",
      `That image is ${read.width} by ${read.height} pixels. An advertising image needs to be at least ${ASSET_LIMITS.MIN_WIDTH} by ${ASSET_LIMITS.MIN_HEIGHT}, or the channel will refuse it or show it badly.`,
      { field: "file", code: C.TOO_SMALL });
  }
  if (read.width > ASSET_LIMITS.MAX_WIDTH || read.height > ASSET_LIMITS.MAX_HEIGHT) {
    throw fail("VALIDATION", "That image's dimensions are larger than GRAV stores.",
      { field: "file", code: C.TOO_LARGE_DIMENSIONS });
  }

  /* ── IDENTICAL BYTES ARE ONE ASSET, WITHIN ONE COMPANY ─────────────────
     Company-scoped on purpose. Two companies uploading the same stock photo is
     ordinary; a global hash would collide the second with a row it cannot see
     and would leak that somebody else has that file. */
  const existing = await MarketingAdvertisingAsset
    .findOne({ companyId: company, sha256: read.sha256 }).lean();
  if (existing) {
    return {
      asset: publicAsset(existing, company),
      deduplicated: true,
      means: "This company already has this exact image. Its existing review state is unchanged — uploading it again does not re-open or re-approve it.",
    };
  }

  /* ── ONLY NOW DOES ANYTHING GET WRITTEN ────────────────────────────────
     Every refusal above happens before a byte reaches storage, so a rejected
     upload leaves nothing behind. */
  const drive = deps.companyDrive || companyDrive;
  const stored = await drive.uploadCompanyFile(buffer, {
    fileName: `${read.sha256.slice(0, 12)} ${safeFileName(fields.fileName)}`,
    mimeType: read.mimeType,
    /* Its own place in the company Drive, beside the other company files rather
       than in a second file system. */
    folderPath: ["Marketing", "Advertising assets", String(company)],
  });

  const doc = await MarketingAdvertisingAsset.create({
    companyId: company,
    assetGroupId: new mongoose.Types.ObjectId(),
    version: 1,
    mimeType: read.mimeType,
    byteSize: read.byteSize,
    width: read.width,
    height: read.height,
    sha256: read.sha256,
    originalFileName: safeFileName(fields.fileName),
    extensionAgreedWithBytes: imageBytes.extensionAgrees(fields.fileName, read.mimeType).agrees,
    storageRef: str(stored.driveFileId),
    storageOrigin: "company_drive",
    uploadedBy: actor,
    uploadedAt: new Date(),
    note: str(fields.note).slice(0, ASSET_LIMITS.NOTE_MAX),
    state: "awaiting_review",
  });

  await appendHistory({
    companyId: company,
    assetId: doc._id,
    action: "uploaded",
    fromState: "",
    toState: "awaiting_review",
    actor,
    sha256: read.sha256,
  });

  return {
    asset: publicAsset(doc.toObject(), company),
    deduplicated: false,
    means: "The image is stored. It cannot be used in an advertisement until somebody other than the uploader confirms the company is authorised to advertise with it.",
  };
}

async function load({ companyId, assetId, env = process.env, withStorage = false }) {
  const company = assertCompany(companyId);
  const { assetId: internal } = identity.decodeAssetId(assetId, { companyId: str(company) }, env);

  const query = MarketingAdvertisingAsset.findOne({ _id: internal, companyId: company });
  /* `storageRef` is `select: false`, so it arrives only where it is needed —
     the binary read — and never in a view that could be serialised. */
  if (withStorage) query.select("+storageRef");

  const doc = await query;
  if (!doc) throw fail("NOT_FOUND", "That advertising image could not be found.", { field: "assetId" });
  return { company, doc };
}

/**
 * Review an exact version.
 *
 * ── THREE ASSERTIONS, NOT A BUTTON ─────────────────────────────────────────
 * A single "approve" lets somebody approve without deciding anything. Each of
 * these is a separate statement a person makes, stored on the history row, so
 * an audit shows what was claimed.
 *
 * ── AND THE UPLOADER MAY NOT BE THE REVIEWER ───────────────────────────────
 * The same separation the campaign plan enforces on approval. One person who
 * can both put a picture into GRAV and authorise the company to pay to publish
 * it is one mistake away from an advertisement nobody else has seen.
 */
async function review({ companyId, user, assetId, decision, payload = {}, env = process.env }) {
  const { company, doc } = await load({ companyId, assetId, env });
  const actor = actorFrom(user);
  const fields = assertNoPointer(payload, APPROVAL_FIELDS);

  const wanted = str(decision);
  if (!["approve", "return", "revoke"].includes(wanted)) {
    throw fail("VALIDATION", "A review is approve, return or revoke.", { field: "decision" });
  }

  const target = wanted === "approve" ? "approved" : wanted === "return" ? "returned" : "revoked";
  const allowed = ASSET_TRANSITIONS[doc.state] || [];
  if (!allowed.includes(target)) {
    throw fail("CAMPAIGN_DRAFT_STATE_CONFLICT",
      `An image that is ${STATE_BY_CODE[doc.state]?.label.toLowerCase() || doc.state} cannot be ${wanted}d.`,
      { field: "state", code: C.STATE_CONFLICT });
  }

  if (wanted !== "revoke" && !isReviewer(user)) {
    throw fail("CAMPAIGN_DRAFT_DECISION_FORBIDDEN",
      "Deciding whether the company may advertise with an image is an administrator's call.",
      { field: "actor" });
  }

  if (wanted === "approve") {
    if (String(doc.uploadedBy.id) === String(actor.id)) {
      throw fail("CAMPAIGN_DRAFT_DECISION_FORBIDDEN",
        "The person who uploaded an image cannot be the one who authorises the company to advertise with it. Somebody else has to look at it.",
        { field: "actor", code: C.SELF_APPROVAL });
    }

    const missing = APPROVAL_ASSERTION_CODES.filter((c) => fields[c] !== true);
    if (missing.length) {
      throw fail("VALIDATION",
        `An approval confirms all of: ${APPROVAL_ASSERTIONS.map((a) => a.label).join("; ")}.`,
        { field: "assertions", missing, code: C.ASSERTIONS_INCOMPLETE });
    }

    /* ── THE REVIEWER SAW THESE BYTES ─────────────────────────────────────
       Optional, and honoured when given: a caller that showed somebody a
       specific version can quote its hash, and an approval arriving against a
       different one is refused rather than recorded. */
    if (str(fields.expectedSha256) && str(fields.expectedSha256).toLowerCase() !== doc.sha256) {
      throw fail("CONFLICT",
        "The image that was reviewed is not the one being approved.",
        { field: "expectedSha256", code: C.VERSION_MISMATCH });
    }
  }

  const from = doc.state;
  doc.state = target;
  doc.revision += 1;

  if (target === "approved") {
    doc.approvedBy = actor;
    doc.approvedAt = new Date();
    doc.approvalAssertions = Object.fromEntries(APPROVAL_ASSERTION_CODES.map((c) => [c, true]));
    /* Stored beside the decision: the approval is OF these bytes. */
    doc.approvedSha256 = doc.sha256;
  }
  if (target === "revoked") {
    doc.revokedBy = actor;
    doc.revokedAt = new Date();
    doc.revokedReason = str(fields.note).slice(0, ASSET_LIMITS.REASON_MAX);
  }

  await doc.save();

  await appendHistory({
    companyId: company,
    assetId: doc._id,
    action: wanted,
    fromState: from,
    toState: target,
    actor,
    reason: fields.note,
    assertions: target === "approved"
      ? Object.fromEntries(APPROVAL_ASSERTION_CODES.map((c) => [c, true]))
      : null,
    sha256: doc.sha256,
  });

  return {
    asset: publicAsset(doc.toObject(), company),
    means: target === "approved"
      ? "This exact image may now be used in an advertisement. A different file would be a different image with its own review."
      : target === "revoked"
        ? "This image cannot be used in anything new. Anything already sent to an advertising channel is unaffected — GRAV cannot reach into a channel and remove a picture it has already uploaded."
        : "The image has been sent back. It can be reviewed again.",
  };
}

/**
 * The exact version a deployment may use, or a refusal saying why not.
 *
 * ── THE ONLY DOOR A CREATION PATH HAS ──────────────────────────────────────
 * It returns the bytes' identity, not a pointer, and it refuses anything that
 * is not an approved, current version of this company's.
 */
async function forDeployment({ companyId, assetId, env = process.env }) {
  const { company, doc } = await load({ companyId, assetId, env });

  if (!DEPLOYABLE_STATES.includes(doc.state)) {
    const spec = STATE_BY_CODE[doc.state];
    throw fail("CAMPAIGN_DEPLOYMENT_NOT_READY",
      doc.state === "revoked"
        ? "That advertising image has been withdrawn, so it cannot be used in anything new."
        : `That advertising image is ${(spec?.label || doc.state).toLowerCase()}. ${spec?.means || ""}`.trim(),
      { field: "assetId", code: C.NOT_DEPLOYABLE });
  }

  return {
    assetId: doc._id,
    publicAssetId: identity.encodeAssetId({ companyId: str(company), assetId: str(doc._id) }, env),
    companyId: company,
    mimeType: doc.mimeType,
    byteSize: doc.byteSize,
    width: doc.width,
    height: doc.height,
    sha256: doc.sha256,
    originalFileName: doc.originalFileName,
    approvedAt: doc.approvedAt,
    revision: doc.revision,
  };
}

/** The exact approved bytes, read back from storage and re-verified. */
async function readBytes({ companyId, assetId, env = process.env }, deps = {}) {
  const { doc } = await load({ companyId, assetId, env, withStorage: true });
  const drive = deps.companyDrive || companyDrive;

  const { stream } = await drive.streamCompanyFile(doc.storageRef);
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.length;
    /* Bounded on the way back too: storage returning more than the recorded
       size means the row and the bytes disagree, and reading it all into memory
       first would be the wrong way to find that out. */
    if (total > ASSET_LIMITS.MAX_BYTES) {
      throw fail("CHANNEL_MALFORMED_RESPONSE", "That advertising image could not be read.", { field: "assetId" });
    }
    chunks.push(chunk);
  }
  const buffer = Buffer.concat(chunks);

  /* ── THE BYTES ARE RE-HASHED EVERY TIME THEY ARE READ ──────────────────
     Storage is a shared company Drive that people can open. A file replaced
     there would otherwise be published as the approved image, and the approval
     would be a claim about bytes that no longer exist. */
  const read = imageBytes.inspect(buffer);
  if (!read.ok || read.sha256 !== doc.sha256) {
    console.error(`[marketing-asset] stored bytes no longer match the approved image ${doc._id}`);
    throw fail("CAMPAIGN_DEPLOYMENT_NOT_READY",
      "The stored copy of that advertising image no longer matches what was approved, so GRAV will not use it.",
      { field: "assetId", code: C.VERSION_MISMATCH });
  }

  return {
    buffer,
    mimeType: doc.mimeType,
    sha256: doc.sha256,
    byteSize: doc.byteSize,
    fileName: doc.originalFileName,
  };
}

/* ── THE PUBLIC VIEW ────────────────────────────────────────────────────────
   Built field by field. No `storageRef`, no `_id`, no `assetGroupId` — a spread
   would publish whatever a future field turns out to be the day it is added. */
function publicAsset(doc, companyId, env = process.env) {
  const spec = STATE_BY_CODE[doc.state] || null;
  return {
    assetId: identity.encodeAssetId({ companyId: str(companyId), assetId: str(doc._id) }, env),
    fileName: doc.originalFileName,
    format: doc.mimeType === "image/png" ? "PNG" : "JPEG",
    byteSize: doc.byteSize,
    width: doc.width,
    height: doc.height,
    /* Shown so a person can check GRAV is talking about the file they think.
       Not a secret: it is a hash of a picture they uploaded. */
    contentHash: doc.sha256,
    extensionAgreedWithBytes: doc.extensionAgreedWithBytes,
    state: doc.state,
    stateLabel: spec?.label || doc.state,
    stateMeans: spec?.means || "",
    usableInAdvertising: DEPLOYABLE_STATES.includes(doc.state),
    uploadedBy: doc.uploadedBy ? { name: doc.uploadedBy.name, at: doc.uploadedAt } : null,
    approvedBy: doc.approvedBy?.name ? { name: doc.approvedBy.name, at: doc.approvedAt } : null,
    revokedBy: doc.revokedBy?.name ? { name: doc.revokedBy.name, at: doc.revokedAt } : null,
    revokedReason: doc.revokedReason || "",
    note: doc.note || "",
    version: doc.version,
    revision: doc.revision,
  };
}

async function list({ companyId, state = null, limit = 25, env = process.env }) {
  const company = assertCompany(companyId);
  const selector = { companyId: company };
  if (str(state)) selector.state = str(state);

  const rows = await MarketingAdvertisingAsset.find(selector)
    .sort({ createdAt: -1 })
    .limit(Math.min(Math.max(Number(limit) || 25, 1), 100))
    .lean();

  return {
    assets: rows.map((r) => publicAsset(r, company, env)),
    vocabulary: {
      states: ASSET_STATES.map((s) => ({ code: s.code, label: s.label, means: s.means })),
      assertions: APPROVAL_ASSERTIONS.map((a) => ({ code: a.code, label: a.label, means: a.means })),
      limits: {
        maxBytes: ASSET_LIMITS.MAX_BYTES,
        minWidth: ASSET_LIMITS.MIN_WIDTH,
        minHeight: ASSET_LIMITS.MIN_HEIGHT,
        formats: ["JPEG", "PNG"],
      },
    },
  };
}

async function detail({ companyId, assetId, env = process.env }) {
  const { company, doc } = await load({ companyId, assetId, env });
  const history = await MarketingAdvertisingAssetHistory
    .find({ companyId: company, assetId: doc._id }).sort({ at: 1 }).lean();

  return {
    asset: publicAsset(doc.toObject(), company, env),
    history: history.map((h) => ({
      at: h.at,
      action: h.action,
      fromState: h.fromState || null,
      toState: h.toState || null,
      by: h.actor?.name || "",
      reason: h.reason || "",
      /* What was asserted, not that a button was pressed. */
      assertions: h.assertions || null,
      contentHash: h.sha256 || null,
    })),
  };
}

module.exports = {
  upload,
  review,
  forDeployment,
  readBytes,
  list,
  detail,
  publicAsset,
  isReviewer,
  __internals: { assertNoPointer, safeFileName },
};
