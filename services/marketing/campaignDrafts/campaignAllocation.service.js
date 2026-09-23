// services/marketing/campaignDrafts/campaignAllocation.service.js
//
// CLAIMING THE IDENTITIES A CAMPAIGN PLAN SHARES WITH OTHER PLANS.
//
// ── WHY THIS IS A SEPARATE STEP, BEFORE HISTORY ────────────────────────────
// The history-first protocol makes a plan's own revisions safe: the unique
// `(company, draft, revision)` index means two callers cannot both claim revision
// 4 of one plan. It does nothing for identities shared BETWEEN plans.
//
// Two concurrent creates mint different `draftId`s, so each reserves a valid
// history row with no collision at all — and both rows carry the same `draftRef`
// or the same `utmCampaign`, because both derived it from the same state a moment
// earlier. One projection then hits the plan collection's unique index and the
// loser holds canonical, append-only history that can never be applied.
// Reconciliation retries it for ever and fails every time.
//
// So the ordering is: claim the shared identity atomically, THEN write history.
// A claim that cannot be had is refused at a point where nothing is recorded, and
// the refusal is an honest 409 rather than a permanent inconsistency.
//
// Everything here is company-scoped. The counter, the reservation and the intent
// each carry the company as the leading key of a unique index, so two companies
// run independent reference sequences and may hold the same campaign identity.
"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");

const { fail } = require("../../storePurchase/errors");
const {
  MarketingCampaignRefCounter,
  MarketingCampaignIdentity,
  MarketingCampaignCreateIntent,
} = require("../../../models/CMS_Models/Marketing/MarketingCampaignAllocation");

const str = (v) => String(v ?? "").trim();

/* ── THE CREATE IDEMPOTENCY KEY ──────────────────────────────────────────────
   Bounded, printable, and deliberately narrow. A UUID, a ULID or a client-side
   request id all fit; a JSON blob, a URL and an access token do not.

   The lower bound matters as much as the upper: a one-character key is a key two
   unrelated requests will collide on, and a collision here means the second
   request is answered with the first request's plan. Eight characters is the
   shortest thing that can plausibly be unique per request. */
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/;

function assertIdempotencyKey(value) {
  const key = str(value);
  if (!key) {
    throw fail("CAMPAIGN_DRAFT_KEY_REQUIRED",
      "Creating a campaign plan needs an idempotency key, so a retry after a dropped connection continues the same plan instead of creating a second one.",
      { field: "idempotencyKey" });
  }
  if (!KEY_PATTERN.test(key)) {
    throw fail("CAMPAIGN_DRAFT_KEY_REQUIRED",
      "An idempotency key must be 8 to 128 characters of letters, numbers, and . _ : or -. A request id or a UUID is the usual choice.",
      { field: "idempotencyKey", min: 8, max: 128 });
  }
  /* ── AND IT IS NOT A PLACE TO PUT A SECRET ─────────────────────────────────
     The key is stored durably and appears in logs and diagnostics. Somebody
     passing a token as a "unique enough" value would be persisting a credential
     in a collection nobody thinks of as sensitive. Refused by shape: anything
     long and credential-looking is far likelier to be a mistake than a key. */
  if (/^(?:Bearer|Basic)\s/i.test(key) || /^ey[A-Za-z0-9_-]{20,}/.test(key)) {
    throw fail("CAMPAIGN_DRAFT_KEY_REQUIRED",
      "That looks like a credential rather than a request identifier. An idempotency key is stored and logged, so it must not be one.",
      { field: "idempotencyKey" });
  }
  return key;
}

/**
 * A stable fingerprint of the validated payload.
 *
 * ── GENERATED VALUES ARE STRIPPED FIRST ────────────────────────────────────
 * The canonical plan carries values GRAV produces rather than the caller: a
 * content reference's `capturedAt` is stamped at validation time, so two attempts
 * at the SAME creation differ by a few milliseconds. Hashing that made every
 * retry look like a key reused for a different plan — the honest refusal for a
 * real client bug, fired at the one caller doing exactly the right thing.
 *
 * So the basis is the caller's intent, with GRAV's own timestamps removed.
 */
const fingerprintBasis = (canonicalPayload) => {
  const basis = { ...canonicalPayload };
  if (Array.isArray(basis.contentRefs)) {
    basis.contentRefs = basis.contentRefs.map(({ kind, contentId, capturedName }) => ({
      kind, contentId, capturedName: capturedName || "",
    }));
  }
  /* The reference is allocated mid-command and the owner is derived from the
     actor, not sent. Neither is part of what the caller asked for. */
  delete basis.draftRef;
  delete basis.owner;
  return basis;
};

/* Deterministic JSON: object keys sorted at every depth, so a body differing only
   in property order hashes the same. `JSON.stringify`'s own array replacer filters
   top-level keys rather than ordering nested ones, which is not what is needed. */
function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(",")}}`;
}

const fingerprint = (canonicalPayload) => crypto
  .createHash("sha256")
  .update(stableJson(fingerprintBasis(canonicalPayload)))
  .digest("hex");

/**
 * The next reference for this company and year, allocated atomically.
 *
 * ── `$inc` ON ONE DOCUMENT IS THE GUARANTEE ────────────────────────────────
 * Single-document updates are atomic in MongoDB without a transaction, which is
 * the one primitive available here. Two concurrent callers receive 4 and 5; they
 * cannot both receive 4, which is what reading the largest existing reference
 * allowed.
 *
 * Gaps are accepted and documented: a caller that takes 5 and then fails leaves 5
 * unused. The sequence is a reference, not a count, and nothing reads it as one.
 * Returning a number on failure would be a second write that can also fail, and
 * one two callers could then both take.
 */
async function allocateReference({ companyId, now = new Date() }) {
  const company = toObjectId(companyId, "companyId");
  const year = now.getUTCFullYear();

  const counter = await MarketingCampaignRefCounter.findOneAndUpdate(
    { companyId: company, year },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );

  const seq = Number(counter?.seq);
  if (!Number.isSafeInteger(seq) || seq < 1) {
    /* The counter is the only source of a reference. A non-number from it is a
       GRAV fault and must not be papered over with a fallback that could
       duplicate. */
    console.error("[campaign-draft] reference counter returned an unusable value for company", String(company));
    throw fail("CONFLICT", "GRAV could not allocate a reference for this campaign plan. Please try again.");
  }

  return { draftRef: `MCP-${year}-${String(seq).padStart(4, "0")}`, year, seq };
}

/**
 * The reference this intent owns: read it, or establish it atomically.
 *
 * ── WHY THIS IS ONE OPERATION AND NOT A READ FOLLOWED BY A WRITE ───────────
 * The caller used to read `intent.draftRef`, find it empty, allocate a number and
 * `$set` it. Two concurrent requests under one key both read empty, both
 * allocated — 0001 and 0002 — and both wrote. Last write wins on the intent, while
 * each caller carried on with its OWN local number. The history row and the plan
 * then took whichever caller reserved the history first, so the intent could end up
 * recording 0002 for a plan that is actually 0001.
 *
 * An intent disagreeing with its own plan is the failure this closes. The fence is
 * a conditional `$set`: the reference is written only while it is still unset, so
 * exactly one caller establishes it and the other is handed the established value.
 * The loser's allocated number becomes an unused gap, which is acceptable and
 * documented; the loser continuing on a reference nobody recorded is not.
 *
 * @returns {Promise<{draftRef:string, established:boolean, gapped:string|null}>}
 */
async function ensureIntentReference({ companyId, idempotencyKey }) {
  const company = toObjectId(companyId, "companyId");
  const key = str(idempotencyKey);

  /* The ordinary case on a retry: already established, nothing to allocate. */
  const current = await MarketingCampaignCreateIntent
    .findOne({ companyId: company, idempotencyKey: key }).lean();
  if (current && str(current.draftRef)) {
    return { draftRef: str(current.draftRef), established: false, gapped: null };
  }
  if (!current) {
    throw fail("CONFLICT", "GRAV lost track of this creation. Please try again.");
  }

  const candidate = (await allocateReference({ companyId: company })).draftRef;

  const claimed = await MarketingCampaignCreateIntent.findOneAndUpdate(
    {
      companyId: company,
      idempotencyKey: key,
      /* The fence. Matches only while no reference has been established. */
      $or: [{ draftRef: "" }, { draftRef: { $exists: false } }, { draftRef: null }],
    },
    { $set: { draftRef: candidate, stage: "reference_allocated" } },
    { new: true },
  );

  if (claimed) {
    return { draftRef: str(claimed.draftRef), established: true, gapped: null };
  }

  /* Somebody else established it first. Theirs is the reference this creation
     owns, and the number allocated a moment ago is simply never used. */
  const winner = await MarketingCampaignCreateIntent
    .findOne({ companyId: company, idempotencyKey: key }).lean();
  const settled = str(winner?.draftRef);
  if (!settled) {
    /* Neither established nor readable. A GRAV fault; answering with the local
       candidate is exactly the behaviour being removed. */
    console.error("[campaign-draft] intent reference could not be established for company", String(company));
    throw fail("CONFLICT", "GRAV could not allocate a reference for this campaign plan. Please try again.");
  }
  return { draftRef: settled, established: false, gapped: candidate };
}

/**
 * The durable identity of one identity-claiming command.
 *
 * ── THE WHOLE COMMAND, NOT JUST WHAT IT ASKS FOR ───────────────────────────
 * This was derived from the company, the plan, the revision and the requested
 * campaign identity. Those four are not enough to tell two commands apart: two
 * concurrent edits can change different names, budgets, schedules, content or
 * audiences while requesting the SAME identity at the same revision. They produced
 * one token, each treated the provisional row as its own, and the one that lost the
 * history race released the claim the winner was relying on.
 *
 * So the token covers the complete validated resulting plan. Two commands differing
 * in any field a caller chose derive different tokens, and a command can only ever
 * release a claim created for its own exact resulting state.
 *
 * Derived rather than generated, so a RETRY of the same interrupted edit produces
 * the same token with nothing held in process memory and no reliance on a clock —
 * both being exactly what an interrupted command cannot depend on.
 *
 * `fingerprintBasis` strips the values GRAV generates rather than the caller
 * choosing: a content reference's `capturedAt`, stamped at validation time, would
 * otherwise make every retry a different command.
 */
const claimTokenFor = ({ companyId, draftId, revision, resulting }) => crypto
  .createHash("sha256")
  .update([
    str(companyId),
    str(draftId),
    Number(revision),
    /* The COMPLETE resulting plan, not just the identity it asks for. */
    stableJson(fingerprintBasis(resulting || {})),
  ].join("|"))
  .digest("hex")
  .slice(0, 32);

/**
 * Claim a campaign identity PROVISIONALLY for one plan revision, or refuse.
 *
 * ── THE REFUSAL COMES BEFORE ANY HISTORY ───────────────────────────────────
 * That is the point of claiming at all. A conflict found here costs the caller a
 * 409 and costs the database nothing; the same conflict found at projection time
 * leaves an unapplicable history row.
 *
 * ── AND PROVISIONAL IS NOT YET PERMANENT ───────────────────────────────────
 * The claim blocks other plans immediately — an in-flight identity must not be
 * stealable — and becomes permanent only when `commitIdentity` records that the
 * revision wanting it was accepted. An edit that loses its revision race has its
 * claim resolved rather than holding the identity for ever.
 *
 * Three outcomes, and the third is the correction:
 *
 *   claimed      nothing held it; this command now does, provisionally
 *   mine         this exact command already claimed it (a retry) — continue
 *   refused      somebody else holds it, committed or in flight
 *
 * @returns {Promise<{claimed:boolean, mine:boolean, claimToken:string}>}
 */
async function claimIdentity({
  companyId, utmCampaign, draftId, draftRef = "", revision, resulting,
}) {
  const company = toObjectId(companyId, "companyId");
  const identity = str(utmCampaign).toLowerCase();
  if (!identity) return { claimed: false, mine: true, claimToken: "" };

  const draft = toObjectId(draftId, "draftId");
  /* The token identifies this COMMAND, so a different edit asking for the same
     identity at the same revision gets a different one and cannot release this
     claim. */
  const claimToken = claimTokenFor({ companyId: company, draftId: draft, revision, resulting });

  try {
    await MarketingCampaignIdentity.create({
      companyId: company,
      utmCampaign: identity,
      draftId: draft,
      draftRef: str(draftRef),
      claimedAtRevision: Number(revision) || 1,
      status: "provisional",
      claimToken,
      current: true,
      at: new Date(),
    });
    return { claimed: true, mine: true, claimToken };
  } catch (err) {
    if (err?.code !== 11000) throw err;

    const existing = await MarketingCampaignIdentity
      .findOne({ companyId: company, utmCampaign: identity }).lean();

    /* This exact command's own claim. A retry after an interruption, continuing
       rather than re-claiming. */
    if (existing && existing.claimToken === claimToken) {
      return { claimed: false, mine: true, claimToken };
    }

    /* The same PLAN holding it from an accepted revision — the plan reverting to an
       identity it already owns. Legitimate and not a new claim. */
    if (existing && String(existing.draftId) === String(draft) && existing.status === "committed") {
      return { claimed: false, mine: true, claimToken };
    }

    /* ── IN FLIGHT FOR SOMEBODY ELSE, OR THEIRS FOR GOOD ──────────────────────
       Both refuse, and the wording differs because the reader's options differ: a
       committed identity is gone for ever, while one held by a request still in
       flight may be free in a moment if that request loses its race. */
    if (existing && existing.status === "provisional") {
      throw fail("CAMPAIGN_DRAFT_UTM_TAKEN",
        `Another campaign plan in your company is currently claiming the campaign identity "${identity}". If that change does not go through, the identity becomes available again.`,
        { field: "utmCampaign", claimState: "in_flight" });
    }

    throw fail("CAMPAIGN_DRAFT_UTM_TAKEN",
      `Another campaign plan in your company already uses the campaign identity "${identity}". Two campaigns sharing one become a single indistinguishable row in every analytics report, and a committed identity is never released — not by cancelling the plan that holds it, and not by that plan later changing to a different one.`,
      { field: "utmCampaign", claimState: "committed" });
  }
}

/**
 * Commit a claim, because the revision that wanted it was accepted.
 *
 * Fenced on the command's own token, so this cannot commit somebody else's claim.
 * Idempotent: committing an already-committed row changes nothing.
 */
async function commitIdentity({ companyId, utmCampaign, claimToken }) {
  const company = toObjectId(companyId, "companyId");
  const identity = str(utmCampaign).toLowerCase();
  if (!identity || !str(claimToken)) return { committed: false };

  const out = await MarketingCampaignIdentity.findOneAndUpdate(
    { companyId: company, utmCampaign: identity, claimToken: str(claimToken) },
    { $set: { status: "committed", committedAt: new Date() } },
    { new: true },
  );
  return { committed: Boolean(out) };
}

/**
 * Resolve a provisional claim whose revision did not happen.
 *
 * ── FENCED ON THE COMMAND'S OWN TOKEN ──────────────────────────────────────
 * This is the half that could go badly wrong. A cleanup that deleted "any
 * provisional claim on this identity" would remove a claim belonging to a
 * different request that is still running, and that request would then reserve
 * history for an identity it no longer holds — reintroducing the unapplicable row
 * the whole protocol exists to prevent.
 *
 * So the selector names the token AND requires the row still to be provisional. A
 * claim that has since been committed is never removed, and a claim belonging to
 * another command cannot be matched at all.
 */
async function releaseClaim({ companyId, utmCampaign, claimToken }) {
  const company = toObjectId(companyId, "companyId");
  const identity = str(utmCampaign).toLowerCase();
  if (!identity || !str(claimToken)) return { released: false };

  const out = await MarketingCampaignIdentity.findOneAndDelete({
    companyId: company,
    utmCampaign: identity,
    claimToken: str(claimToken),
    status: "provisional",
  });
  return { released: Boolean(out) };
}

/**
 * Restore a committed reservation for an identity an accepted revision carries.
 *
 * ── AN ACCEPTED REVISION MUST NEVER LACK ITS RESERVATION ───────────────────
 * The reservation is what stops another plan taking the name. If an accepted
 * revision carries an identity and no reservation exists — a release that should
 * not have happened, or data from before this protocol — the plan is unprotected
 * and nothing would notice.
 *
 * So the reservation is recreated, committed, owned by that plan. It is NOT
 * recreated when another plan already holds it: that is a genuine ownership
 * conflict a human has to resolve, and inventing a second owner would make the
 * unique index reject it anyway.
 *
 * @returns {Promise<{restored:boolean, conflict:boolean}>}
 */
async function restoreCommittedIdentity({
  companyId, utmCampaign, draftId, draftRef = "", revision, resulting,
}) {
  const company = toObjectId(companyId, "companyId");
  const identity = str(utmCampaign).toLowerCase();
  if (!identity) return { restored: false, conflict: false };

  const draft = toObjectId(draftId, "draftId");
  const existing = await MarketingCampaignIdentity
    .findOne({ companyId: company, utmCampaign: identity }).lean();

  if (existing) {
    if (String(existing.draftId) !== String(draft)) return { restored: false, conflict: true };
    if (existing.status === "committed") return { restored: false, conflict: false };
    /* This plan's own provisional row for an accepted revision: commit it. */
    const out = await MarketingCampaignIdentity.findOneAndUpdate(
      { companyId: company, utmCampaign: identity, draftId: draft, status: "provisional" },
      { $set: { status: "committed", committedAt: new Date() } },
      { new: true },
    );
    return { restored: Boolean(out), conflict: false };
  }

  try {
    await MarketingCampaignIdentity.create({
      companyId: company,
      utmCampaign: identity,
      draftId: draft,
      draftRef: str(draftRef),
      claimedAtRevision: Number(revision) || 1,
      status: "committed",
      claimToken: claimTokenFor({ companyId: company, draftId: draft, revision, resulting }),
      committedAt: new Date(),
      current: true,
      at: new Date(),
    });
    return { restored: true, conflict: false };
  } catch (err) {
    if (err?.code !== 11000) throw err;
    /* Somebody created it in between. Whether that is a conflict depends on who. */
    const raced = await MarketingCampaignIdentity
      .findOne({ companyId: company, utmCampaign: identity }).lean();
    return { restored: false, conflict: String(raced?.draftId) !== String(draft) };
  }
}

/**
 * Provisional claims with no accepted revision behind them, for an operator.
 *
 * ── GRAV DOES NOT EXPIRE THESE, AND SAYS SO ────────────────────────────────
 * A claim whose revision has not happened and whose plan has not moved past it is
 * genuinely undecided: a request that is merely slow looks identical to one that
 * died. Expiring it on a timer would eventually steal a claim from a live request,
 * which is the failure the fencing exists to prevent.
 *
 * The honest consequence is that a crashed request whose caller never retries, and
 * whose plan no other edit advances, leaves a claim that blocks that one name
 * indefinitely. GRAV does not pretend otherwise and does not describe it as "in
 * flight" for ever. It is surfaced here as a BLOCKED claim with its age, for a
 * human to look at, and `releaseBlockedClaim` is the operator action that resolves
 * it — deliberately manual, because only a person can know the request is not
 * coming back.
 */
async function blockedClaims({ companyId, olderThanSeconds = 0 }) {
  const company = toObjectId(companyId, "companyId");
  const rows = await MarketingCampaignIdentity
    .find({ companyId: company, status: "provisional" })
    .sort({ at: 1 })
    .lean();

  const now = Date.now();
  return rows
    .map((r) => ({
      utmCampaign: r.utmCampaign,
      draftRef: r.draftRef || "",
      claimedAtRevision: r.claimedAtRevision,
      claimToken: r.claimToken,
      ageSeconds: Math.max(0, Math.round((now - new Date(r.at).getTime()) / 1000)),
    }))
    .filter((r) => r.ageSeconds >= Number(olderThanSeconds || 0));
}

/**
 * An operator releasing a claim they have decided is abandoned.
 *
 * Fenced on the token and on the row still being provisional, so this cannot take a
 * committed identity and cannot race a command that is finishing. It refuses when an
 * accepted revision carries the identity, because that is not an abandoned claim —
 * it is a reservation the plan needs.
 */
async function releaseBlockedClaim({ companyId, utmCampaign, claimToken, acceptedRevisionCarriesIt }) {
  if (acceptedRevisionCarriesIt) {
    throw fail("CONFLICT",
      "That campaign identity is carried by an accepted plan revision, so its reservation is not abandoned and must not be released.",
      { field: "utmCampaign" });
  }
  return releaseClaim({ companyId, utmCampaign, claimToken });
}

/** Every claim a plan holds, committed or in flight. */
async function claimsFor({ companyId, draftId }) {
  const company = toObjectId(companyId, "companyId");
  return MarketingCampaignIdentity
    .find({ companyId: company, draftId: toObjectId(draftId, "draftId") })
    .sort({ claimedAtRevision: 1, at: 1 })
    .lean();
}

/**
 * Make `current` agree with the plan's actual identity.
 *
 * ── IT IS DERIVED, SO IT IS SET IN ONE PLACE ───────────────────────────────
 * The first version only cleared the old flag inside the edit's success path, which
 * left it wrong in two situations: an edit repaired by reconciliation never ran that
 * code, and a plan returning to an identity it already owns found its row still
 * marked superseded with nothing to set it back.
 *
 * `current` is not a fact of its own — it is a projection of which identity the plan
 * currently carries. So it is computed from the plan, here, and called from both the
 * success path and the reconciliation that repairs an interrupted one.
 *
 * No row is ever deleted: a committed identity stays reserved whether or not it is
 * the live one.
 */
async function syncCurrentIdentity({ companyId, draftId, utmCampaign }) {
  const company = toObjectId(companyId, "companyId");
  const draft = toObjectId(draftId, "draftId");
  const live = str(utmCampaign).toLowerCase();

  await MarketingCampaignIdentity.updateMany(
    { companyId: company, draftId: draft, utmCampaign: { $ne: live }, current: true },
    { $set: { current: false } },
  );

  if (live) {
    await MarketingCampaignIdentity.updateOne(
      { companyId: company, draftId: draft, utmCampaign: live },
      { $set: { current: true } },
    );
  }
}

/** Which plan owns an identity in this company, if any. */
async function identityOwner({ companyId, utmCampaign }) {
  const company = toObjectId(companyId, "companyId");
  const identity = str(utmCampaign).toLowerCase();
  if (!identity) return null;
  return MarketingCampaignIdentity.findOne({ companyId: company, utmCampaign: identity }).lean();
}

/**
 * Claim or resume a creation intent.
 *
 * ── CLAIMED FIRST, BEFORE ANYTHING ELSE ────────────────────────────────────
 * The intent is the only thing that can recognise a retry, so it has to exist
 * before the reference and the identity are allocated — otherwise a retry after an
 * interruption at either of those steps has nothing to find and allocates again.
 *
 * `$setOnInsert` with an upsert makes the claim atomic: two concurrent requests
 * carrying one key produce one row, and both then read the same one.
 *
 * @returns {Promise<{intent:object, fresh:boolean}>}
 */
async function claimCreateIntent({ companyId, idempotencyKey, payloadFingerprint }) {
  const company = toObjectId(companyId, "companyId");
  const key = assertIdempotencyKey(idempotencyKey);
  const draftId = new mongoose.Types.ObjectId();

  const intent = await MarketingCampaignCreateIntent.findOneAndUpdate(
    { companyId: company, idempotencyKey: key },
    {
      $setOnInsert: {
        companyId: company,
        idempotencyKey: key,
        payloadFingerprint,
        /* The plan's id is minted HERE, by whichever request claims the intent, so
           every later step — the identity reservation, the history row, the
           projection — addresses the same plan on a retry. */
        draftId,
        draftRef: "",
        utmCampaign: "",
        stage: "claimed",
        at: new Date(),
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );

  /* ── THE SAME KEY WITH A DIFFERENT PAYLOAD IS A BUG, NOT A RETRY ──────────
     Answering with the first plan would hide it behind an apparent success, and
     the author would believe the second plan exists. */
  if (intent.payloadFingerprint !== payloadFingerprint) {
    throw fail("CAMPAIGN_DRAFT_KEY_REUSED",
      "That creation key was already used for a different campaign plan. Use a new key for a new plan; reusing one would return the earlier plan and hide the mistake.",
      { field: "idempotencyKey" });
  }

  return { intent, fresh: intent.stage === "claimed" && !str(intent.draftRef) };
}

/** Record how far a creation got. Advisory; every step is independently idempotent. */
async function advanceIntent({ companyId, idempotencyKey, stage, set = {} }) {
  const company = toObjectId(companyId, "companyId");
  return MarketingCampaignCreateIntent.findOneAndUpdate(
    { companyId: company, idempotencyKey: str(idempotencyKey) },
    { $set: { stage, ...set } },
    { new: true },
  );
}

function toObjectId(value, field) {
  const raw = str(value);
  if (!mongoose.Types.ObjectId.isValid(raw)) {
    throw fail("VALIDATION", `${field} is not an identifier GRAV can use.`, { field });
  }
  return new mongoose.Types.ObjectId(raw);
}

module.exports = {
  KEY_PATTERN,
  assertIdempotencyKey,
  fingerprint,
  fingerprintBasis,
  stableJson,
  allocateReference,
  ensureIntentReference,
  claimIdentity,
  commitIdentity,
  releaseClaim,
  claimsFor,
  restoreCommittedIdentity,
  blockedClaims,
  releaseBlockedClaim,
  claimTokenFor,
  syncCurrentIdentity,
  identityOwner,
  claimCreateIntent,
  advanceIntent,
};
