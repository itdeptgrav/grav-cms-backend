// services/rnd/avatar.service.js
//
// THE AVATAR LIBRARY OF ONE STYLE: APPEND-ONLY, CHECKED, AND POINTED AT.
//
// ── THE THREE RULES ─────────────────────────────────────────────────────────
//   1. A REVISION IS NEVER WRITTEN TO. Saving a changed avatar appends revision
//      n+1 under the same `avatarId`; revision n stays exactly as it was, so a
//      drape set up on it still describes the body it was made on.
//   2. NOTHING IS STORED THAT THE SERVER DID NOT CHECK. `avatarContract.js`
//      recomputes the content hash and every tolerance status before a row is
//      written; a client cannot save a "Fit verified" the numbers deny.
//   3. A POINTER MUST RESOLVE. A pattern revision may only name an avatar
//      revision that exists on its own style with the same content hash
//      (`assertAvatarRef`), so a reference is never to a body nobody can find.
//
// Writes are a single conditional `$push` against the style, guarded on the
// revision not already existing — two tabs saving at once get one revision and
// one `REVISION_CONFLICT`, never two revision 3s. The style document itself is
// never loaded and saved, so no other field of it can be clobbered from here.
"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");

const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");
const { AVATAR_LIMITS } = require("../../models/CMS_Models/RnD/AvatarRevision");
const { styleForCompany } = require("../companyContext/rndScope.service");
const { verifyContract, TOLERANCE_MM } = require("./avatarContract");
const { fail } = require("../storePurchase/errors");

const str = (v) => (v === null || v === undefined ? "" : String(v).trim());
const clean = (v, max) => str(v).replace(/[\u0000-\u001f\u007f]/g, "").slice(0, max);
const mintAvatarId = () => `AV-${crypto.randomBytes(5).toString("hex").toUpperCase()}`;
const actorOf = (a) => ({ id: str(a?.id), name: str(a?.name), email: str(a?.email).toLowerCase() });

function assertContext(ctx) {
  if (!ctx?.companyId) throw fail("COMPANY_CONTEXT_UNAVAILABLE", "Your company could not be resolved.");
}

async function avatarsOf(styleId) {
  const row = await SampleStyle.findById(styleId).select("+rndAvatars rndAvatars").lean();
  return row?.rndAvatars || [];
}

/** What a list shows: identity, verdict and dimensions. No content. */
function summary(row) {
  return {
    avatarId: row.avatarId,
    revision: row.revision,
    name: row.name,
    contentSha256: row.contentSha256,
    engine: row.engine,
    profile: row.profile,
    presetId: row.presetId,
    requestedMm: row.requestedMm,
    generatedMm: row.generatedMm,
    verdict: row.verification?.verdict,
    defaultPose: row.defaultPose,
    author: row.author,
    createdAt: row.createdAt,
  };
}

/** A whole revision, with the contract the browser regenerates from. */
function full(row) {
  return {
    ...summary(row),
    tolerance: row.tolerance,
    verification: row.verification,
    renderMesh: row.renderMesh,
    collisionBody: row.collisionBody,
    contract: { schema: row.schema, content: row.content, contentSha256: row.contentSha256 },
  };
}

/**
 * Every avatar on the style, newest revision first within each, avatars by
 * most recent activity.
 */
async function listAvatars(ctx, { styleId } = {}) {
  assertContext(ctx);
  const style = await styleForCompany(ctx.companyId, styleId);
  const rows = await avatarsOf(style._id);
  const byId = new Map();
  for (const r of rows) {
    if (!byId.has(r.avatarId)) byId.set(r.avatarId, []);
    byId.get(r.avatarId).push(r);
  }
  const avatars = [...byId.values()].map((list) => {
    list.sort((a, b) => b.revision - a.revision);
    return { latest: summary(list[0]), revisions: list.map(summary) };
  });
  avatars.sort((a, b) => new Date(b.latest.createdAt) - new Date(a.latest.createdAt));
  return { avatars, tolerance: { passMm: TOLERANCE_MM.pass, reviewMm: TOLERANCE_MM.review } };
}

async function readAvatarRevision(ctx, { styleId, avatarId, revision } = {}) {
  assertContext(ctx);
  const style = await styleForCompany(ctx.companyId, styleId);
  const n = Number(revision);
  const row = (await avatarsOf(style._id)).find((r) => r.avatarId === str(avatarId) && r.revision === n);
  if (!row) throw fail("NOT_FOUND", "That avatar revision was not found on this style.", { avatarId, revision });
  return { avatar: full(row) };
}

/**
 * Save an avatar: a new avatar (no `avatarId`) starts at revision 1; an
 * existing one appends `expectedRevision + 1`. An unchanged body — same content
 * hash as the latest revision — creates nothing and returns that revision.
 */
async function saveAvatar(ctx, { styleId, avatarId, expectedRevision, name, contract, actor = null } = {}) {
  assertContext(ctx);
  const style = await styleForCompany(ctx.companyId, styleId);
  let checked;
  try {
    checked = verifyContract(contract);
  } catch (err) {
    if (err.code) throw fail(err.code, err.message, err.details || {});
    throw err;
  }
  const rows = await avatarsOf(style._id);
  if (rows.length >= AVATAR_LIMITS.REVISIONS_PER_STYLE) {
    throw fail("AVATAR_LIMIT", `This style already holds ${AVATAR_LIMITS.REVISIONS_PER_STYLE} avatar revisions, `
      + "which is the most one style keeps.", { limit: AVATAR_LIMITS.REVISIONS_PER_STYLE });
  }

  let id = str(avatarId);
  let next = 1;
  if (id) {
    const mine = rows.filter((r) => r.avatarId === id).sort((a, b) => b.revision - a.revision);
    if (!mine.length) throw fail("NOT_FOUND", "That avatar is not on this style.", { avatarId: id });
    const latest = mine[0];
    if (expectedRevision !== undefined && expectedRevision !== null && Number(expectedRevision) !== latest.revision) {
      throw fail("REVISION_CONFLICT", "This avatar was saved from another screen while you were working. "
        + "Reload it and try again.", { expectedRevision: Number(expectedRevision), currentRevision: latest.revision });
    }
    if (latest.contentSha256 === contract.contentSha256) {
      return { avatar: full(latest), created: false };
    }
    next = latest.revision + 1;
  } else {
    id = mintAvatarId();
  }

  const entry = {
    avatarId: id,
    revision: next,
    name: clean(name, 120) || (checked.presetId ? checked.presetId : `${checked.profile} avatar`),
    schema: contract.schema,
    contentSha256: contract.contentSha256,
    engine: checked.engine,
    profile: checked.profile,
    presetId: checked.presetId,
    requestedMm: checked.requestedMm,
    generatedMm: checked.generatedMm,
    tolerance: { passMm: TOLERANCE_MM.pass, reviewMm: TOLERANCE_MM.review },
    verification: { verdict: checked.verdict, rows: checked.rows },
    defaultPose: checked.defaultPose,
    renderMesh: checked.renderMesh,
    collisionBody: checked.collisionBody,
    content: contract.content,
    author: actorOf(actor),
    createdAt: new Date(),
  };
  /* The guard is in the filter: the push happens only if no row already has
     this avatar and revision. */
  const res = await SampleStyle.updateOne(
    { _id: style._id, rndAvatars: { $not: { $elemMatch: { avatarId: id, revision: next } } } },
    { $push: { rndAvatars: entry } },
  );
  if (!res.modifiedCount) {
    throw fail("REVISION_CONFLICT", "Another save of this avatar landed first. Reload it and try again.",
      { avatarId: id, revision: next });
  }
  return { avatar: full(entry), created: true };
}

/**
 * Prove a pattern revision's avatar reference names a real, unchanged avatar
 * revision on the same style. Returns the normalised reference.
 */
async function assertAvatarRef(companyId, styleId, ref) {
  const avatarId = str(ref?.avatarId);
  const revision = Number(ref?.revision);
  if (!avatarId || !Number.isInteger(revision) || revision < 1) {
    throw fail("VALIDATION", "An avatar reference names an avatar and one of its revisions.", { ref });
  }
  if (!mongoose.Types.ObjectId.isValid(str(styleId))) throw fail("NOT_FOUND", "That style was not found.");
  const row = (await avatarsOf(styleId)).find((r) => r.avatarId === avatarId && r.revision === revision);
  if (!row) {
    throw fail("AVATAR_NOT_FOUND", "That avatar revision is not saved on this style.", { avatarId, revision });
  }
  if (str(ref.contentSha256) && str(ref.contentSha256) !== row.contentSha256) {
    throw fail("AVATAR_HASH_MISMATCH", "That avatar revision is not the body this setup was made with.",
      { avatarId, revision });
  }
  return {
    avatarId, revision,
    contentSha256: row.contentSha256,
    engine: row.engine?.name || "",
    engineVersion: row.engine?.version || "",
    verdict: row.verification?.verdict || "",
  };
}

module.exports = { listAvatars, readAvatarRevision, saveAvatar, assertAvatarRef, mintAvatarId };
