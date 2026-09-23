// services/marketing/creativeMedia/creativeMedia.service.js
//
// THE CREATIVE MEDIA LIBRARY: IMAGES FOR PLANNED SOCIAL CONTENT.
//
// ── REUSED, NOT REBUILT ────────────────────────────────────────────────────
// Bytes are verified by the same inspector the advertising image library uses
// (format and dimensions read from the file itself, hash over exactly what
// arrived) and stored in the same private company Drive, which is only ever
// read back through GRAV's own authenticated route. What is NOT reused is the
// advertising library's review: approval for advertising is a different
// question, and a social post's approval belongs to the Content Planner.
//
// ── NOTHING IS WRITTEN UNTIL EVERYTHING IS CHECKED ─────────────────────────
// Size, format, dimensions and duplicates are all decided before a byte
// reaches storage, and the row is written only after storage confirms. A
// failure at any point leaves either nothing, or — if the row cannot be
// written after the file was stored — an orphan the service tries to delete
// and logs. It never leaves a row pointing at bytes that are not there.
//
// ── IT PUBLISHES NOTHING ───────────────────────────────────────────────────
// No social network, advertising channel or public URL is involved anywhere.
"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");

const { fail } = require("../../storePurchase/errors");
const companyDrive = require("../../companyDrive.service");
const imageBytes = require("../assets/imageBytes");
const {
  MarketingCreativeMedia,
  MarketingCreativeMediaEvent,
} = require("../../../models/CMS_Models/Marketing/MarketingCreativeMedia");
const M = require("../../../constants/marketingCreativeMedia");

const str = (v) => String(v ?? "").trim();

const isApprover = (user) => Boolean(user?.isAdmin) || ["admin", "ceo"].includes(str(user?.role));
const isMarketing = (user) => isApprover(user) || str(user?.role) === "marketing";

function actorFrom(user) {
  const raw = str(user?.id);
  if (!mongoose.Types.ObjectId.isValid(raw)) {
    throw fail("CREATIVE_MEDIA_FORBIDDEN", "GRAV records who added or withdrew a file, so this needs a signed-in identity.");
  }
  if (!isMarketing(user)) throw fail("CREATIVE_MEDIA_FORBIDDEN", "The creative media library is Marketing's.");
  return { id: new mongoose.Types.ObjectId(raw), name: str(user?.name), role: str(user?.role) };
}

function assertCompany(companyId) {
  const id = str(companyId);
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw fail("TENANT_MEMBERSHIP_UNPROVEN", "The creative media library needs a proven company.");
  }
  return new mongoose.Types.ObjectId(id);
}

/* ── PUBLIC NAMES ───────────────────────────────────────────────────────── */
const newMediaRef = () => `cmv_${crypto.randomBytes(16).toString("hex")}`;
const newGroupRef = () => `cmg_${crypto.randomBytes(16).toString("hex")}`;
const MEDIA_REF = /^cmv_[0-9a-f]{32}$/;
const GROUP_REF = /^cmg_[0-9a-f]{32}$/;

const notFound = () => fail("CREATIVE_MEDIA_NOT_FOUND", "That file is not in this company's creative media library.");

function safeFileName(raw) {
  const name = str(raw).replace(/[\\/\u0000-\u001f<>:"|?*]/g, "_").slice(0, M.LIMITS.FILE_NAME_MAX);
  return name || "untitled";
}

/* ── RECOGNISING VIDEO, TO REFUSE IT HONESTLY ───────────────────────────────
   Not to accept it: to say "this is a video, and here is why GRAV cannot hold
   one yet" rather than "this is not an image". */
function looksLikeVideo(buf) {
  if (buf.length >= 12 && buf.toString("latin1", 4, 8) === "ftyp") return "MP4 or QuickTime video";
  if (buf.length >= 4 && buf.readUInt32BE(0) === 0x1a45dfa3) return "WebM or Matroska video";
  if (buf.length >= 12 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 11) === "AVI") return "AVI video";
  return null;
}

const REFUSED_WHY = {
  svg: "SVG files can carry scripts, so GRAV does not store them. Export the design as a PNG.",
  gif: "GRAV stores JPEG and PNG images. Export a still as a PNG, or describe an animation in a written reference.",
  webp: "GRAV stores JPEG and PNG images. Export this image as a JPEG or PNG.",
};

const FIELDS = ["fileName", "note"];

function readFields(payload) {
  const keys = Object.keys(payload || {});
  const unknown = keys.filter((k) => !FIELDS.includes(k));
  if (unknown.length) {
    throw fail("VALIDATION",
      `An upload carries one file plus an optional fileName and note. ${unknown.join(", ")} is not accepted — GRAV reads a file's format and size from the file itself, and takes no links.`,
      { unknown });
  }
  const fileName = str(payload.fileName);
  const note = str(payload.note);
  if (note.length > M.LIMITS.NOTE_MAX) throw fail("VALIDATION", `note may be at most ${M.LIMITS.NOTE_MAX} characters.`, { field: "note" });
  return { fileName, note };
}

/** Every check a file must pass, before anything is stored. */
function inspectImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw fail("VALIDATION", "No file arrived with that upload.", { field: "file", code: "no_file" });
  }
  if (buffer.length > M.LIMITS.IMAGE_MAX_BYTES) {
    throw fail("CREATIVE_MEDIA_TOO_LARGE",
      `That file is larger than ${M.LIMITS.IMAGE_MAX_BYTES / (1024 * 1024)}MB, the most GRAV stores for one image.`,
      { field: "file", maxBytes: M.LIMITS.IMAGE_MAX_BYTES });
  }
  const video = looksLikeVideo(buffer);
  if (video) {
    throw fail("CREATIVE_MEDIA_UNSUPPORTED",
      `That is a ${video}. ${M.VIDEO.means}`,
      { field: "file", code: "video_not_supported", blockers: M.VIDEO_BLOCKERS.map((b) => b.code) });
  }
  const read = imageBytes.inspect(buffer);
  if (!read.ok) {
    throw fail("CREATIVE_MEDIA_UNSUPPORTED",
      REFUSED_WHY[read.code] || "GRAV could not read this file as a JPEG or PNG image. A renamed file is not an image — GRAV reads the contents.",
      { field: "file", code: REFUSED_WHY[read.code] ? `${read.code}_not_supported` : "not_an_image" });
  }
  const L = M.LIMITS;
  if (read.width < L.IMAGE_MIN_WIDTH || read.height < L.IMAGE_MIN_HEIGHT) {
    throw fail("VALIDATION",
      `That image is ${read.width} by ${read.height} pixels. A creative image needs to be at least ${L.IMAGE_MIN_WIDTH} by ${L.IMAGE_MIN_HEIGHT}.`,
      { field: "file", code: "too_small" });
  }
  if (read.width > L.IMAGE_MAX_WIDTH || read.height > L.IMAGE_MAX_HEIGHT) {
    throw fail("VALIDATION", `That image is larger than ${L.IMAGE_MAX_WIDTH} by ${L.IMAGE_MAX_HEIGHT} pixels.`,
      { field: "file", code: "too_many_pixels" });
  }
  return read;
}

/* ── WHO MAY WITHDRAW A VERSION ─────────────────────────────────────────────
   One rule, used by the command that enforces it and by the view that offers
   the button, so a screen never offers what the server will refuse. */
const WITHDRAW_REFUSALS = Object.freeze({
  marketing_only: "Withdrawing a file needs the Editor role or higher in Marketing.",
  not_uploader: "Only the person who uploaded this version, an administrator or the CEO can withdraw it.",
  already_withdrawn: "This version has already been withdrawn.",
});

function withdrawProblem(doc, user) {
  if (!isMarketing(user)) return "marketing_only";
  if (!isApprover(user) && String(doc.uploadedBy?.id || "") !== str(user?.id)) return "not_uploader";
  if (doc.state === "withdrawn") return "already_withdrawn";
  return null;
}

function viewerActionsFor(doc, user) {
  const reason = withdrawProblem(doc, user);
  return {
    withdraw: {
      allowed: reason === null,
      reason,
      reasonLabel: reason ? WITHDRAW_REFUSALS[reason] : null,
      reasonRequired: true,
    },
  };
}

/* ── THE PUBLIC VIEW ────────────────────────────────────────────────────────
   Field by field. No `_id`, no `companyId`, no `storageRef`, no URL. */
function present(doc, { latestVersion = null, user = null } = {}) {
  const format = M.IMAGE_FORMATS.find((f) => f.mimeType === doc.mimeType);
  const state = M.STATES.find((s) => s.code === doc.state);
  return {
    mediaRef: doc.mediaRef,
    groupRef: doc.groupRef,
    version: doc.version,
    isLatestVersion: latestVersion === null ? null : doc.version === latestVersion,
    kind: { code: doc.kind, label: M.KINDS.find((k) => k.code === doc.kind)?.label || doc.kind },
    format: format ? format.label : doc.mimeType,
    byteSize: doc.byteSize,
    width: doc.width,
    height: doc.height,
    contentHash: doc.sha256,
    fileName: doc.originalFileName,
    extensionAgreedWithBytes: doc.extensionAgreedWithBytes !== false,
    note: doc.note || "",
    state: { code: doc.state, label: state?.label || doc.state, means: state?.means || "" },
    /* Only an available version whose stored copy still matches can be
       shown, and only through this route. */
    previewable: doc.state === "available" && !doc.integrityFailedAt,
    storedCopyChanged: Boolean(doc.integrityFailedAt),
    uploadedBy: doc.uploadedBy?.name || "",
    uploadedAt: doc.uploadedAt,
    withdrawn: doc.state === "withdrawn"
      ? { by: doc.withdrawnBy?.name || "", at: doc.withdrawnAt, reason: doc.withdrawnReason || "" }
      : null,
    viewerActions: viewerActionsFor(doc, user),
  };
}

async function event(company, doc, action, actor, { reason = "" } = {}) {
  await MarketingCreativeMediaEvent.create({
    companyId: company, groupRef: doc.groupRef, mediaRef: doc.mediaRef, action, reason,
    sha256: doc.sha256, actor, at: new Date(),
  });
}

/**
 * Store one image, as a new file (no groupRef) or as the next version of an
 * existing one (groupRef).
 */
async function upload({ companyId, user, buffer, payload = {}, groupRef = null }, deps = {}) {
  const company = assertCompany(companyId);
  const actor = actorFrom(user);
  const fields = readFields(payload);
  const read = inspectImage(buffer);

  /* The group a new version joins must be this company's. */
  let group = null;
  if (groupRef !== null) {
    const ref = str(groupRef);
    if (!GROUP_REF.test(ref)) throw notFound();
    const versions = await MarketingCreativeMedia.find({ companyId: company, groupRef: ref }).select("version").lean();
    if (!versions.length) throw notFound();
    if (versions.length >= M.LIMITS.VERSIONS_MAX) {
      throw fail("VALIDATION", `A file may have at most ${M.LIMITS.VERSIONS_MAX} versions.`, { field: "file" });
    }
    group = { ref, next: Math.max(...versions.map((v) => v.version)) + 1 };
  }

  /* ── THE SAME BYTES ARE ONE VERSION ─────────────────────────────────────── */
  const existing = await MarketingCreativeMedia.findOne({ companyId: company, sha256: read.sha256 }).lean();
  if (existing) {
    return {
      media: present(existing, { user }),
      deduplicated: true,
      means: existing.state === "withdrawn"
        ? "This exact file is already in the library and was withdrawn. It stays withdrawn; uploading it again does not restore it."
        : "This exact file is already in the library. Nothing new was stored.",
    };
  }

  /* ── ONLY NOW DOES ANYTHING GET WRITTEN ──────────────────────────────── */
  const drive = deps.drive || companyDrive;
  let stored;
  try {
    stored = await drive.uploadCompanyFile(buffer, {
      fileName: `${read.sha256.slice(0, 12)} ${safeFileName(fields.fileName)}`,
      mimeType: read.mimeType,
      folderPath: ["Marketing", "Creative media", String(company)],
    });
  } catch (err) {
    console.error(`[creative-media] storage refused an upload: ${str(err?.message).slice(0, 200)}`);
    throw fail("CREATIVE_MEDIA_STORAGE_UNAVAILABLE", "The file could not be stored. Nothing was saved; try again.");
  }
  if (!str(stored?.driveFileId)) {
    throw fail("CREATIVE_MEDIA_STORAGE_UNAVAILABLE", "The file could not be stored. Nothing was saved; try again.");
  }

  let doc;
  try {
    doc = await MarketingCreativeMedia.create({
      companyId: company,
      mediaRef: newMediaRef(),
      groupRef: group ? group.ref : newGroupRef(),
      version: group ? group.next : 1,
      kind: "image",
      mimeType: read.mimeType,
      byteSize: read.byteSize,
      width: read.width,
      height: read.height,
      sha256: read.sha256,
      originalFileName: safeFileName(fields.fileName),
      extensionAgreedWithBytes: imageBytes.extensionAgrees(fields.fileName, read.mimeType).agrees,
      note: fields.note,
      storageRef: str(stored.driveFileId),
      storageOrigin: "company_drive",
      uploadedBy: actor,
      uploadedAt: new Date(),
      state: "available",
    });
  } catch (err) {
    /* ── NO ROW, SO NO FILE EITHER ─────────────────────────────────────────
       The bytes were stored and the record was not. Remove the bytes (best
       effort) so storage does not fill with files nothing points at. */
    const removed = await (drive.deleteCompanyFile ? drive.deleteCompanyFile(str(stored.driveFileId)) : false);
    if (!removed) console.error("[creative-media] an orphaned stored file could not be removed; it is referenced by no record");
    if (err?.code === 11000) {
      const winner = await MarketingCreativeMedia.findOne({ companyId: company, sha256: read.sha256 }).lean();
      if (winner) return { media: present(winner, { user }), deduplicated: true, means: "This exact file is already in the library. Nothing new was stored." };
      throw fail("CONFLICT", "Another version of this file was added at the same moment. Reload and try again.");
    }
    throw fail("CREATIVE_MEDIA_STORAGE_UNAVAILABLE", "The file could not be recorded. Nothing was saved; try again.");
  }

  await event(company, doc, group ? "version_added" : "uploaded", actor);
  return {
    media: present(doc.toObject(), { latestVersion: doc.version, user }),
    deduplicated: false,
    means: "The file is stored in the creative media library. It is not approved for anything: approving a post happens in the Content Planner, for the whole creative.",
  };
}

async function loadVersion(company, mediaRef, { withStorage = false } = {}) {
  const ref = str(mediaRef);
  if (!MEDIA_REF.test(ref)) throw notFound();
  const q = MarketingCreativeMedia.findOne({ companyId: company, mediaRef: ref });
  if (withStorage) q.select("+storageRef");
  const doc = await q.lean();
  if (!doc) throw notFound();
  return doc;
}

/** GET /creative-media — one row per file, showing its latest version. */
async function list({ companyId, query = {}, user = null } = {}) {
  const company = assertCompany(companyId);
  const unknown = Object.keys(query).filter((k) => !["page", "limit", "state"].includes(k));
  if (unknown.length) throw fail("VALIDATION", "The media list accepts page, limit and state.", { unknown });
  const num = (raw, field, max, fallback) => {
    if (raw === undefined || raw === "") return fallback;
    const n = /^\d+$/.test(str(raw)) ? Number(raw) : NaN;
    if (!Number.isInteger(n) || n < 1 || (max && n > max)) {
      throw fail("VALIDATION", `${field} must be a whole number${max ? ` between 1 and ${max}` : " of 1 or more"}.`, { field });
    }
    return n;
  };
  const page = num(query.page, "page", null, 1);
  const limit = num(query.limit, "limit", M.LIMITS.PAGE_MAX, M.LIMITS.PAGE_DEFAULT);
  const state = str(query.state);
  if (state && !M.STATE_CODES.includes(state)) {
    throw fail("VALIDATION", `state must be one of: ${M.STATE_CODES.join(", ")}.`, { field: "state" });
  }

  const [out] = await MarketingCreativeMedia.aggregate([
    { $match: { companyId: company } },
    { $sort: { version: -1 } },
    { $group: { _id: "$groupRef", latest: { $first: "$$ROOT" }, versions: { $sum: 1 } } },
    ...(state ? [{ $match: { "latest.state": state } }] : []),
    { $sort: { "latest.uploadedAt": -1, _id: 1 } },
    { $facet: { rows: [{ $skip: (page - 1) * limit }, { $limit: limit }], total: [{ $count: "n" }] } },
  ]);
  const total = out?.total?.[0]?.n || 0;
  return {
    media: (out?.rows || []).map((r) => ({
      ...present(r.latest, { latestVersion: r.latest.version, user }),
      versionCount: r.versions,
    })),
    page: { number: page, size: limit, total, pages: Math.ceil(total / limit) },
  };
}

/** GET /creative-media/:groupRef — every version of one file, and its history. */
async function detail({ companyId, groupRef, user = null } = {}) {
  const company = assertCompany(companyId);
  const ref = str(groupRef);
  if (!GROUP_REF.test(ref)) throw notFound();
  const versions = await MarketingCreativeMedia.find({ companyId: company, groupRef: ref }).sort({ version: -1 }).lean();
  if (!versions.length) throw notFound();
  const latest = versions[0].version;
  const events = await MarketingCreativeMediaEvent.find({ companyId: company, groupRef: ref }).sort({ at: 1 }).lean();
  return {
    groupRef: ref,
    versions: versions.map((v) => present(v, { latestVersion: latest, user })),
    history: events.map((e) => ({ action: e.action, mediaRef: e.mediaRef, by: e.actor?.name || "", at: e.at, reason: e.reason, contentHash: e.sha256 })),
  };
}

/* ── WHAT STORAGE WAS FOUND TO HOLD ─────────────────────────────────────────
   Recorded so every other read — list, calendar, a creative's approval — can
   report a changed stored copy without downloading it. Best effort: failing to
   record it never turns a refusal into a success. */
async function markIntegrity(company, doc, matches) {
  try {
    await MarketingCreativeMedia.updateOne(
      { companyId: company, _id: doc._id },
      { $set: { integrityFailedAt: matches ? null : (doc.integrityFailedAt || new Date()) } },
    );
  } catch (err) {
    console.error(`[creative-media] could not record the integrity result for ${doc.mediaRef}: ${str(err?.message).slice(0, 120)}`);
  }
}

/**
 * The exact bytes of one version, for GRAV's own authenticated preview.
 * A withdrawn version is never returned, and neither is a stored copy that no
 * longer hashes to what was recorded.
 */
async function preview({ companyId, mediaRef }, deps = {}) {
  const company = assertCompany(companyId);
  const doc = await loadVersion(company, mediaRef, { withStorage: true });
  if (doc.state === "withdrawn") {
    throw fail("CREATIVE_MEDIA_WITHDRAWN", "This file was withdrawn and is not shown.");
  }
  const drive = deps.drive || companyDrive;
  const chunks = [];
  let total = 0;
  try {
    const { stream } = await drive.streamCompanyFile(doc.storageRef);
    for await (const chunk of stream) {
      total += chunk.length;
      if (total > M.LIMITS.IMAGE_MAX_BYTES) {
        await markIntegrity(company, doc, false);
        throw fail("CREATIVE_MEDIA_INTEGRITY_FAILED", "The stored copy of this file no longer matches the recorded version, so it is not shown.");
      }
      chunks.push(chunk);
    }
  } catch (err) {
    if (err?.code === "CREATIVE_MEDIA_INTEGRITY_FAILED") throw err;
    console.error(`[creative-media] storage could not return ${doc.mediaRef}: ${str(err?.message).slice(0, 200)}`);
    throw fail("CREATIVE_MEDIA_STORAGE_UNAVAILABLE", "The file could not be read right now.");
  }
  const buffer = Buffer.concat(chunks);
  const read = imageBytes.inspect(buffer);
  if (!read.ok || read.sha256 !== doc.sha256) {
    console.error(`[creative-media] stored bytes no longer match ${doc.mediaRef}`);
    await markIntegrity(company, doc, false);
    throw fail("CREATIVE_MEDIA_INTEGRITY_FAILED", "The stored copy of this file no longer matches the recorded version, so it is not shown.");
  }
  if (doc.integrityFailedAt) await markIntegrity(company, doc, true);
  return { buffer, mimeType: doc.mimeType, byteSize: buffer.length, sha256: doc.sha256 };
}

/**
 * Withdraw one version. The uploader of that version, an administrator or the
 * CEO may withdraw it, with a reason. It is never deleted.
 */
async function withdraw({ companyId, user, mediaRef, payload = {} } = {}) {
  const company = assertCompany(companyId);
  const actor = actorFrom(user);
  const unknown = Object.keys(payload || {}).filter((k) => k !== "reason");
  if (unknown.length) throw fail("VALIDATION", "A withdrawal takes a reason and nothing else.", { unknown });
  const reason = str(payload.reason);
  if (!reason) throw fail("VALIDATION", "Say why this file is being withdrawn. It is the only record of the decision.", { field: "reason" });
  if (reason.length > M.LIMITS.REASON_MAX) throw fail("VALIDATION", `reason may be at most ${M.LIMITS.REASON_MAX} characters.`, { field: "reason" });

  const doc = await loadVersion(company, mediaRef);
  const problem = withdrawProblem(doc, user);
  if (problem === "marketing_only" || problem === "not_uploader") {
    throw fail("CREATIVE_MEDIA_FORBIDDEN", WITHDRAW_REFUSALS[problem]);
  }
  /* Withdrawing twice is not an error for somebody allowed to withdraw. */
  if (problem === "already_withdrawn") return { media: present(doc, { user }), duplicate: true };

  const updated = await MarketingCreativeMedia.findOneAndUpdate(
    { companyId: company, _id: doc._id, state: "available" },
    { $set: { state: "withdrawn", withdrawnBy: actor, withdrawnAt: new Date(), withdrawnReason: reason } },
    { new: true },
  ).lean();
  const now = updated || await MarketingCreativeMedia.findOne({ companyId: company, _id: doc._id }).lean();
  if (updated) await event(company, updated, "withdrawn", actor, { reason });
  return { media: present(now, { user }), duplicate: !updated };
}

/**
 * Versions a creative draft names, by reference, confirmed in this company.
 * Returns a map of mediaRef → the stored facts a reference records.
 */
async function forCreative(company, mediaRefs) {
  const refs = [...new Set(mediaRefs.map(str))].filter((r) => MEDIA_REF.test(r));
  const docs = refs.length
    ? await MarketingCreativeMedia.find({ companyId: company, mediaRef: { $in: refs } })
      .select("mediaRef groupRef version mimeType byteSize width height sha256 originalFileName state integrityFailedAt").lean()
    : [];
  return new Map(docs.map((d) => [d.mediaRef, d]));
}

/** The current state of each referenced version, and the latest version of its file. */
async function statesFor(company, mediaRefs) {
  const found = await forCreative(company, mediaRefs);
  const groups = [...new Set([...found.values()].map((d) => d.groupRef))];
  const latest = groups.length
    ? await MarketingCreativeMedia.aggregate([
      { $match: { companyId: company, groupRef: { $in: groups } } },
      { $group: { _id: "$groupRef", latest: { $max: "$version" } } },
    ])
    : [];
  const latestBy = new Map(latest.map((l) => [l._id, l.latest]));
  return { found, latestBy };
}

const vocabulary = Object.freeze({
  kinds: M.KINDS.map((k) => ({ code: k.code, label: k.label, supported: k.supported })),
  states: M.STATES.map((s) => ({ code: s.code, label: s.label, means: s.means })),
  image: {
    formats: M.IMAGE_FORMATS.map((f) => f.label),
    maxBytes: M.LIMITS.IMAGE_MAX_BYTES,
    minWidth: M.LIMITS.IMAGE_MIN_WIDTH,
    minHeight: M.LIMITS.IMAGE_MIN_HEIGHT,
    maxWidth: M.LIMITS.IMAGE_MAX_WIDTH,
    maxHeight: M.LIMITS.IMAGE_MAX_HEIGHT,
  },
  video: {
    supported: false,
    means: M.VIDEO.means,
    blockers: M.VIDEO_BLOCKERS.map((b) => ({ code: b.code, label: b.label, means: b.means })),
  },
  withdrawRefusals: Object.entries(WITHDRAW_REFUSALS).map(([code, label]) => ({ code, label })),
  approvalMeans: "Nothing in this library is approved. A post's creative, including the exact file versions it uses, is approved in the Content Planner. Approval for paid advertising is a separate library and does not carry over.",
  limits: { noteMax: M.LIMITS.NOTE_MAX, reasonMax: M.LIMITS.REASON_MAX, fileNameMax: M.LIMITS.FILE_NAME_MAX, versionsMax: M.LIMITS.VERSIONS_MAX },
});

module.exports = {
  upload, list, detail, preview, withdraw, forCreative, statesFor, present, vocabulary,
  MEDIA_REF, GROUP_REF,
  __internals: { inspectImage, looksLikeVideo, isApprover, withdrawProblem },
};
