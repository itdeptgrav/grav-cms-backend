// services/storePurchase/idempotency.service.js
//
// Store & Purchase — Chunk 1. A RETRY IS NOT A SECOND ORDER.
//
// Chunk 0 pinned the behaviour this removes, with a test that still passes
// because the route has not changed: re-posting a goods receipt is ACCEPTED,
// and the repeat quantity is silently added to stock as "surplus" while the
// purchase order's own accounting hides it. A double-clicked payment is
// recorded twice. Nothing in the domain is idempotent.
//
// ── THE CONTRACT ────────────────────────────────────────────────────────────
//   same key + same payload, completed → replay the original result
//   same key + different payload       → 409, loudly (a client bug)
//   same key, still running            → 409, retry shortly
//   same key, previous attempt failed  → the record is released; retry runs
//   validation failure                 → NO success record is ever written
"use strict";

const crypto = require("crypto");

const SpIdempotencyRecord = require("../../models/CMS_Models/StorePurchase/SpIdempotencyRecord");
const { fail } = require("./errors");

/* How long an IN_PROGRESS claim with no effect may sit before another attempt
   may take it over. Long enough that a slow-but-alive request is never stolen
   from, short enough that a crash does not lock the action for the record's
   whole 30-day life. */
const STALE_CLAIM_MS = 2 * 60 * 1000;

/**
 * A hash that does not change when the client reorders its JSON.
 *
 * Key order is not meaningful in an object, so `{a:1,b:2}` and `{b:2,a:1}`
 * are the SAME request — hashing the raw string would call an identical
 * retry a conflict, which is the failure mode this service exists to avoid.
 */
function canonicalise(value) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(canonicalise);
  if (typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value).sort()) {
      /* An idempotency key inside the body would make every request its own
         payload and defeat the check. */
      if (k === "idempotencyKey") continue;
      out[k] = canonicalise(value[k]);
    }
    return out;
  }
  return value;
}

const hashRequest = (body) =>
  crypto.createHash("sha256").update(JSON.stringify(canonicalise(body ?? {}))).digest("hex");

/**
 * Claim a key before doing the work.
 *
 * @returns {Promise<{outcome:"PROCEED"|"REPLAY", record?, response?}>}
 * @throws  409 on key reuse with a different payload, or while in progress
 */
async function begin({ ctx, operation, key, body }) {
  if (!key || !String(key).trim()) {
    throw fail(
      "IDEMPOTENCY_KEY_REQUIRED",
      "This action needs an Idempotency-Key header so a retry cannot repeat it.",
      { operation },
    );
  }

  /* ── The unique index IS the concurrency guarantee ──────────────────────
   * `create()` is expected to lose on it when a second request arrives with
   * the same key. On a fresh deployment the index may not exist yet —
   * mongoose builds it in the background — and until it does, every
   * "duplicate" insert SUCCEEDS and two requests both proceed. `init()`
   * resolves once the index is built and is a cached no-op afterwards, so
   * this costs one await on the first call of the process and closes a
   * window that would otherwise open exactly when a system is newest. */
  await SpIdempotencyRecord.init();

  const requestHash = hashRequest(body);
  const scope = {
    companyId: ctx.companyId,
    actorId: ctx.actorId,
    operation,
    key: String(key).trim(),
  };

  /* Insert-first, not find-first. Two simultaneous requests both reach this
     line; exactly one wins the unique index and the other is handed the
     existing record — which is what makes concurrent duplicates impossible
     rather than merely unlikely. */
  try {
    const created = await SpIdempotencyRecord.create({
      ...scope,
      requestHash,
      status: "IN_PROGRESS",
    });
    return { outcome: "PROCEED", record: created };
  } catch (err) {
    if (err?.code !== 11000) throw err;
  }

  const existing = await SpIdempotencyRecord.findOne(scope).lean();
  if (!existing) {
    /* The record vanished between the failed insert and this read — a TTL
       expiry at exactly the wrong moment. Treat it as a fresh attempt. */
    const created = await SpIdempotencyRecord.create({ ...scope, requestHash, status: "IN_PROGRESS" });
    return { outcome: "PROCEED", record: created };
  }

  if (existing.requestHash !== requestHash) {
    throw fail(
      "IDEMPOTENCY_KEY_REUSED",
      "This request key was already used for a different request. Start the action again.",
      { operation },
    );
  }

  if (existing.status === "COMPLETED") {
    return {
      outcome: "REPLAY",
      record: existing,
      response: { status: existing.responseStatus, body: existing.responseBody },
    };
  }

  if (existing.status === "EFFECT_APPLIED") {
    /* ── THE RECOVERY PATH ─────────────────────────────────────────────────
     * The domain mutation committed, and something after it did not — the
     * history write, the response, or the process itself. Re-running the
     * mutation would double it, which is precisely the failure this service
     * exists to prevent. So the retry does NOT redo the work: it is handed
     * back what was already done, and the caller finishes the unfinished
     * part. */
    return {
      outcome: "RECOVER",
      record: existing,
      effect: {
        entityType: existing.resultEntityType || "",
        entityId: existing.resultEntityId || null,
      },
    };
  }

  if (existing.status === "IN_PROGRESS") {
    /* ── Stale-claim recovery ──────────────────────────────────────────────
     * A process that crashed mid-request leaves IN_PROGRESS behind. Without
     * this the action would be locked until the 30-day TTL expired, and the
     * user would be told to "wait a moment" forever.
     *
     * Reclaiming is only safe because no effect marker is present: if the
     * mutation HAD committed, the status would be EFFECT_APPLIED and the
     * branch above would have caught it. */
    const age = Date.now() - new Date(existing.heartbeatAt || existing.createdAt).getTime();
    if (age > STALE_CLAIM_MS) {
      const reclaimed = await SpIdempotencyRecord.findOneAndUpdate(
        { _id: existing._id, status: "IN_PROGRESS", effectAppliedAt: null },
        { $set: { heartbeatAt: new Date(), requestHash } },
        { new: true },
      );
      if (reclaimed) return { outcome: "PROCEED", record: reclaimed };
    }
    throw fail(
      "IDEMPOTENCY_IN_PROGRESS",
      "That action is still being processed. Wait a moment before trying again.",
      { operation },
    );
  }

  /* FAILED: the previous attempt did not change anything, so the key is
     released for this identical payload to try again. */
  await SpIdempotencyRecord.updateOne(
    { _id: existing._id },
    { $set: { status: "IN_PROGRESS", failureReason: "", requestHash } },
  );
  return { outcome: "PROCEED", record: { ...existing, status: "IN_PROGRESS" } };
}

/**
 * The domain mutation has committed.
 *
 * Called INSIDE the same transaction as the mutation where the deployment
 * supports one, and immediately after it where it does not. Either way, from
 * this moment a retry may never re-run the work.
 */
async function markEffectApplied({ record, entityType = "", entityId = null, session = null }) {
  if (!record?._id) return;
  await SpIdempotencyRecord.updateOne(
    { _id: record._id },
    {
      $set: {
        status: "EFFECT_APPLIED",
        effectAppliedAt: new Date(),
        resultEntityType: entityType,
        resultEntityId: entityId,
        heartbeatAt: new Date(),
      },
    },
    session ? { session } : {},
  );
}

/** Record the successful result so an identical retry replays it. */
async function complete({ record, status, body, entityType = "", entityId = null, session = null }) {
  if (!record?._id) return;
  await SpIdempotencyRecord.updateOne(
    { _id: record._id },
    {
      $set: {
        status: "COMPLETED",
        responseStatus: status,
        responseBody: body,
        ...(entityType ? { resultEntityType: entityType } : {}),
        ...(entityId ? { resultEntityId: entityId } : {}),
        completedAt: new Date(),
      },
    },
    session ? { session } : {},
  );
}

/**
 * Release a key after a failure.
 *
 * A refused request must NOT become a replayable success — otherwise a
 * validation error would be served back forever to a client that has since
 * fixed its payload.
 */
async function abandon({ record, reason = "" }) {
  if (!record?._id) return;
  /* CRITICAL: only a claim whose effect never landed may be released. A
     record already marked EFFECT_APPLIED must stay that way even though the
     request failed — releasing it would invite the retry to repeat a
     mutation that already happened. The filter, not the caller, enforces
     this, so a route that forgets cannot cause a double effect. */
  await SpIdempotencyRecord.updateOne(
    { _id: record._id, effectAppliedAt: null },
    { $set: { status: "FAILED", failureReason: String(reason).slice(0, 500) } },
  );
}

module.exports = {
  begin, complete, abandon, markEffectApplied, hashRequest, canonicalise, STALE_CLAIM_MS,
};
