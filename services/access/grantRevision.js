// services/access/grantRevision.js
//
// THE SHARED AUTHORIZATION REVISION (GAC-2 correction, 25 Sep 2026).
//
// Some guards cache "what may this person do" for a few seconds
// (services/access/hrAuthorization.js, services/qcViewer.js). Clearing those
// caches after a grant change is necessary but not sufficient: the clear runs
// in ONE process, can fail, and says nothing to another instance holding its
// own copy. So correctness no longer rests on the clear.
//
// Every access change advances `revision` on the `access_grant_head` document
// in the same transaction as the change (and the administrator write advances
// it too). A cached authorization answer records the revision it was computed
// under and is used only while the stored revision is unchanged. The first
// request after a change, in any process, therefore misses the cache and
// re-reads the grant — whether or not anybody managed to clear anything.
//
// If the revision cannot be read, the caller must treat that as a MISS (and
// recompute from the database), never as a hit. That keeps it fail-closed: a
// cache can only ever be skipped, not trusted blindly.
"use strict";

const { AccessGrantHead, HEAD_ID } = require("../../models/Access/AccessGrantEvent");

/** The current revision. Throws on a lookup failure — callers treat that as a cache miss. */
async function currentGrantRevision() {
  const head = await AccessGrantHead.findById(HEAD_ID).select("revision").lean();
  return head?.revision || 0;
}

/**
 * Advance the revision. Pass `session` to make it part of a transaction (the
 * grant write does); without one it is a single atomic $inc (the
 * administrator-status write). Throws on failure so the caller can refuse to
 * report success.
 */
async function bumpGrantRevision(session) {
  await AccessGrantHead.collection.updateOne(
    { _id: HEAD_ID },
    { $inc: { revision: 1 }, $setOnInsert: { seq: 0, lastHash: "0".repeat(64) } },
    { upsert: true, ...(session ? { session } : {}) },
  );
}

/**
 * A cache entry is usable only if it was stored under the current revision.
 * Any failure to read the revision is a miss.
 */
async function cacheEntryIsCurrent(entry) {
  if (!entry || entry.revision === undefined) return false;
  try {
    return entry.revision === await currentGrantRevision();
  } catch {
    return false;
  }
}

/** The revision to stamp on a fresh cache entry, or null (do not cache) if unreadable. */
async function revisionForNewEntry() {
  try { return await currentGrantRevision(); } catch { return null; }
}

module.exports = { currentGrantRevision, bumpGrantRevision, cacheEntryIsCurrent, revisionForNewEntry };
