// services/marketing/campaignDrafts/deploymentAttempt.service.js
//
// THE ONE PLACE A DEPLOYMENT ATTEMPT IS EVER RECORDED. NO PROVIDER IS CALLED HERE.
//
// ── WHAT THIS IS FOR ───────────────────────────────────────────────────────
// A deployment attempt is two append-only facts — an intent before the external
// request and a result after it — and getting the order right is the difference
// between a recoverable crash and orphaned advertising objects nobody knows about.
// That ordering is a protocol, and a protocol enforced in one place is a protocol.
// Spread across call sites it is a convention.
//
// So every future write of either fact goes through here. A structural test asserts
// that no Marketing service or route reaches the collections directly, because
// Mongoose middleware cannot see `Model.collection.*` and this boundary is what
// covers the gap the model cannot.
//
// ── AND NOTHING HERE TALKS TO A PROVIDER ───────────────────────────────────
// It records facts about attempts. The code that makes the external request will
// call `begin` before it and `settle` after it, and will live elsewhere. A test
// reads this file's source and fails if it imports a provider client or an HTTP
// client, because the day those two jobs live in one file is the day an exception
// between them leaves a campaign created and unrecorded.
"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");

const { fail } = require("../../storePurchase/errors");
/* Every type a deployment may record — including the controlled ones, which
   are created only into the proof account. Deployability is the matrix's call. */
const { RECORDABLE_CAMPAIGN_TYPES: SUPPORTED_CAMPAIGN_TYPES } = require("../../../constants/marketingDeploymentReadiness");
const {
  MarketingCampaignDeploymentAttemptCounter,
  MarketingCampaignDeploymentAttemptIntent,
  MarketingCampaignDeploymentAttemptResult,
} = require("../../../models/CMS_Models/Marketing/MarketingCampaignDeploymentAttempt");

const str = (v) => String(v ?? "").trim();

const toObjectId = (value, field) => {
  const raw = str(value);
  if (!mongoose.Types.ObjectId.isValid(raw)) {
    throw fail("VALIDATION", `${field} is not an identifier GRAV can use.`, { field });
  }
  return new mongoose.Types.ObjectId(raw);
};

/**
 * A fingerprint of what an attempt is about to create.
 *
 * Deterministic, so a retry of one logical attempt produces the same value and a
 * reconciliation can tell whether an unresolved intent was for the same thing a
 * retry is about to do. Deep key ordering, for the same reason the creation
 * fingerprint has it: a payload differing only in property order is the same
 * payload.
 */
function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(",")}}`;
}

const fingerprintOf = (plannedObjects) => crypto
  .createHash("sha256")
  .update(stableJson(plannedObjects))
  .digest("hex")
  .slice(0, 64);

/**
 * Allocate the next attempt number for one deployment, atomically.
 *
 * ── NOT count + 1, AND NOT newest + 1 ──────────────────────────────────────
 * Both read a value a concurrent caller is about to change, so two attempts can
 * compute the same number. The unique index would then reject one — but only AFTER
 * it may already have started an external request, which is the one moment a
 * rejection is useless.
 *
 * `$inc` on a single document is the one atomicity MongoDB gives without a
 * transaction. Two callers receive 4 and 5, never 4 twice.
 *
 * A gap is acceptable and deliberate: a caller that takes 3 and then fails leaves 3
 * unused for ever. An attempt number is an identity, not a count, and reclaiming one
 * would let two different attempts both be called the third.
 */
async function allocateAttemptNumber({ companyId, deploymentId }) {
  const company = toObjectId(companyId, "companyId");
  const deployment = toObjectId(deploymentId, "deploymentId");

  const counter = await MarketingCampaignDeploymentAttemptCounter.findOneAndUpdate(
    { companyId: company, deploymentId: deployment },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );

  const seq = Number(counter?.seq);
  if (!Number.isSafeInteger(seq) || seq < 1) {
    console.error("[deployment-attempt] attempt counter returned an unusable value for deployment", str(deployment));
    throw fail("CONFLICT", "GRAV could not allocate an attempt number. Please try again.");
  }
  return seq;
}

/* ── WHAT MAY BE ATTEMPTED, AND WHAT MAY BE RECORDED ────────────────────────
   Kept here rather than derived, because each one is a decision. */
const OUTCOMES = Object.freeze(["succeeded", "partially_created", "failed", "refused_preflight"]);
const OBJECT_ORIGINS = Object.freeze(["created", "observed"]);
/* ── GRAV'S ROLES, MATCHING BOTH MODELS ────────────────────────────────────
   `targeting_term` is a Google keyword and a Meta detailed-targeting entry: one
   rung of two different ladders, named once in GRAV's words. Kept identical to
   the enums in the two deployment models — a role this list allows and a model
   refuses would pass validation and then fail the write. */
const OBJECT_ROLES = Object.freeze([
  "budget", "campaign", "audience_group", "creative", "advertisement",
  "targeting_term", "location_target", "language_target",
  "lead_form", "lead_form_link",
]);

/* ── WHAT A CALLER MAY DO NEXT ───────────────────────────────────────────────
   `begin` used to return an intent and leave the caller to work out whether calling
   a provider was safe — which meant separately reading `hasUnresolvedAttempt` and
   racing against it. Two reads, two answers, and the window between them is exactly
   where a duplicate campaign gets created.

   So the disposition comes back with the intent, decided from the same read.
   `mayCallProvider` is the single boolean a future writer branches on, and it is
   true in exactly one case. */
const DISPOSITIONS = Object.freeze({
  /* This call recorded the intent. Nothing external has happened for it yet. */
  NEW_INTENT: "new_intent",
  /* An intent exists with no result: the previous external outcome is UNKNOWN.
     Objects may exist in the advertising account that GRAV cannot see, so calling a
     provider now is how a second set gets created. */
  RECONCILIATION_REQUIRED: "reconciliation_required",
  /* An intent exists and is settled. There is nothing left to attempt. */
  ALREADY_SETTLED: "already_settled",
});

const isSuppliedText = (v) => typeof v === "string" && v.trim().length > 0;
const isSuppliedNumber = (v) => typeof v === "number" && Number.isFinite(v);

const asDate = (v) => {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (isSuppliedText(v)) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
};

/**
 * Validate one whole command and reduce it to the values that identify it.
 *
 * ── VALIDATION RUNS BEFORE THE LOOKUP, ALWAYS ──────────────────────────────
 * A malformed retry must not slip through merely because its key already exists.
 * Checking after the lookup would mean a caller could reuse a key with nonsense in
 * every other field and be handed a perfectly good intent.
 */
function normaliseCommand({
  companyId, deploymentId, commandKey, approvedRevision, channel, campaignType,
  requestedBy, authorizedBy, plannedObjects,
}) {
  const company = toObjectId(companyId, "companyId");
  const deployment = toObjectId(deploymentId, "deploymentId");

  const key = str(commandKey);
  if (!key) {
    throw fail("VALIDATION",
      "An attempt needs a command identity, so a retry continues the same attempt instead of starting a second one.",
      { field: "commandKey" });
  }
  if (key.length > 128) {
    throw fail("VALIDATION", "A command identity may be at most 128 characters.", { field: "commandKey" });
  }

  if (!isSuppliedNumber(approvedRevision) || !Number.isInteger(approvedRevision) || approvedRevision < 1) {
    throw fail("VALIDATION",
      "An attempt names the exact approved plan revision it is of.",
      { field: "approvedRevision" });
  }

  const spec = SUPPORTED_CAMPAIGN_TYPES.find((t) => t.code === str(campaignType));
  if (!spec) {
    throw fail("VALIDATION", "That is not a campaign type GRAV deploys.", { field: "campaignType" });
  }
  if (spec.channel !== str(channel)) {
    throw fail("VALIDATION",
      "The campaign type and the channel disagree.",
      { field: "channel" });
  }

  /* Both identities are ids, not names: a name is a snapshot and an id is an
     identity, and an attempt spends somebody's money. */
  const requester = {
    id: toObjectId(requestedBy?.id, "requestedBy.id"),
    name: str(requestedBy?.name),
    role: str(requestedBy?.role),
  };
  const authorisedAt = asDate(authorizedBy?.at);
  if (!authorisedAt) {
    throw fail("VALIDATION",
      "An attempt's authorisation needs the time it was given, so it can be placed against what the plan said then.",
      { field: "authorizedBy.at" });
  }
  const authoriser = {
    id: toObjectId(authorizedBy?.id, "authorizedBy.id"),
    name: str(authorizedBy?.name),
    at: authorisedAt,
  };

  if (!Array.isArray(plannedObjects) || !plannedObjects.length) {
    throw fail("VALIDATION",
      "An attempt says what it is about to create. An empty plan is not an attempt.",
      { field: "plannedObjects" });
  }
  for (const planned of plannedObjects) {
    if (!planned || typeof planned !== "object" || !OBJECT_ROLES.includes(str(planned.role))) {
      throw fail("VALIDATION",
        `Each planned object needs a role: ${OBJECT_ROLES.join(", ")}.`,
        { field: "plannedObjects.role" });
    }
  }

  return {
    company,
    deployment,
    key,
    approvedRevision,
    channel: str(channel),
    campaignType: spec.code,
    requester,
    authoriser,
    plannedObjects,
  };
}

/**
 * The fingerprint of a complete command.
 *
 * Everything the command decided. A key reused with a different revision, channel,
 * type, planned objects, requester or authorisation produces a different value and is
 * therefore a different command — not a retry.
 */
const commandFingerprintOf = (command) => crypto
  .createHash("sha256")
  .update(stableJson({
    approvedRevision: command.approvedRevision,
    channel: command.channel,
    campaignType: command.campaignType,
    requestedBy: String(command.requester.id),
    authorizedBy: String(command.authoriser.id),
    authorizedAt: command.authoriser.at.toISOString(),
    planned: command.plannedObjects,
  }))
  .digest("hex")
  .slice(0, 64);

/**
 * Record that an attempt is about to start, or report why one may not.
 *
 * ── CALLED BEFORE ANY EXTERNAL REQUEST, ALWAYS ─────────────────────────────
 * The intent is durable before a provider is touched, so a crash mid-request leaves
 * a record saying an attempt started. Without it, a crash leaves real advertising
 * objects and no evidence they exist.
 *
 * ── AND THE ANSWER SAYS WHETHER A PROVIDER MAY BE CALLED ───────────────────
 * `mayCallProvider` is true for exactly one disposition: `new_intent`. Returning an
 * unresolved intent does NOT authorise another external call — the previous
 * outcome is unknown, and calling again is how a second set of objects is created.
 *
 * @returns {Promise<{intent:object, created:boolean, disposition:string, mayCallProvider:boolean, reason:string}>}
 */
async function begin({
  companyId, deploymentId, commandKey, approvedRevision, channel, campaignType,
  requestedBy, authorizedBy, plannedObjects = [], deploymentMarker = "", now = new Date(),
}) {
  /* ── VALIDATE FIRST, LOOK UP SECOND ──────────────────────────────────────
     So a malformed retry cannot bypass validation by carrying a key that exists. */
  const command = normaliseCommand({
    companyId, deploymentId, commandKey, approvedRevision, channel, campaignType,
    requestedBy, authorizedBy, plannedObjects,
  });
  const commandFingerprint = commandFingerprintOf(command);

  /* ── WRITTEN BEFORE THE REQUEST, WHICH IS THE ENTIRE POINT ───────────────
     An intent records that an external request is about to be made. Without a
     marker it records that and nothing else: a process that dies before the
     answer arrives leaves a row saying "something may exist in an advertising
     account" with no way on earth to find out what. Required, so that cannot
     be an intent anybody accidentally writes.

     It is deliberately NOT part of the command fingerprint. It is DERIVED from
     the command, so including it would add no distinguishing power and would
     make a change to the derivation look like a change to the command. */
  const marker = str(deploymentMarker);
  if (!marker) {
    throw fail("VALIDATION",
      "An attempt needs the deployment marker GRAV will attach to what it creates, so a lost response can be reconciled.",
      { field: "deploymentMarker" });
  }

  const existing = await MarketingCampaignDeploymentAttemptIntent
    .findOne({ companyId: command.company, deploymentId: command.deployment, commandKey: command.key });

  if (existing) {
    /* ── THE SAME NAME IS NOT THE SAME COMMAND ────────────────────────────
       A key reused with a different revision, channel, type, planned objects,
       requester or authorisation is a different command wearing a used name.
       Returning the earlier intent for it would authorise an external request
       nobody described. Refused before a number is allocated and before anything
       is written. */
    if (existing.commandFingerprint !== commandFingerprint) {
      throw fail("CONFLICT",
        "That command identity was already used for a different attempt. Use a new identity for a different attempt; reusing one would start an external request that does not match what was recorded.",
        { field: "commandKey", attemptNo: existing.attemptNo });
    }

    /* Settled or not, decided from this same read rather than from a second one a
       caller would have to race against. */
    const result = await MarketingCampaignDeploymentAttemptResult
      .findOne({ companyId: command.company, intentId: existing._id }).select("_id outcome").lean();

    if (result) {
      return {
        intent: existing,
        created: false,
        disposition: DISPOSITIONS.ALREADY_SETTLED,
        mayCallProvider: false,
        reason: `This attempt is already settled as ${result.outcome}. There is nothing further to attempt under this command identity.`,
      };
    }

    return {
      intent: existing,
      created: false,
      disposition: DISPOSITIONS.RECONCILIATION_REQUIRED,
      mayCallProvider: false,
      reason: "This attempt was recorded as started and GRAV does not know how it ended. Objects may exist in the advertising account that GRAV has no record of, so the account must be reconciled against this attempt before anything else is attempted.",
    };
  }

  const attemptNo = await allocateAttemptNumber({
    companyId: command.company, deploymentId: command.deployment,
  });

  try {
    const intent = await MarketingCampaignDeploymentAttemptIntent.create({
      companyId: command.company,
      deploymentId: command.deployment,
      attemptNo,
      commandKey: command.key,
      commandFingerprint,
      deploymentMarker: marker,
      approvedRevision: command.approvedRevision,
      channel: command.channel,
      campaignType: command.campaignType,
      requestedBy: command.requester,
      authorizedBy: command.authoriser,
      startedAt: now,
      plannedFingerprint: fingerprintOf(command.plannedObjects),
      plannedSummary: {
        objectCount: command.plannedObjects.length,
        objectRoles: [...new Set(command.plannedObjects.map((o) => str(o?.role)).filter(Boolean))].sort(),
      },
    });

    return {
      intent,
      created: true,
      disposition: DISPOSITIONS.NEW_INTENT,
      /* The one case. */
      mayCallProvider: true,
      reason: "This attempt is recorded and nothing external has happened for it yet.",
    };
  } catch (err) {
    if (err?.code !== 11000) throw err;
    /* A concurrent caller under the same command identity won. Theirs is the
       attempt; the number this one allocated becomes a gap. It is unresolved, so
       this caller may NOT call a provider. */
    const raced = await MarketingCampaignDeploymentAttemptIntent
      .findOne({ companyId: command.company, deploymentId: command.deployment, commandKey: command.key });
    if (!raced) throw err;

    if (raced.commandFingerprint !== commandFingerprint) {
      throw fail("CONFLICT",
        "That command identity was already used for a different attempt.",
        { field: "commandKey", attemptNo: raced.attemptNo });
    }
    return {
      intent: raced,
      created: false,
      disposition: DISPOSITIONS.RECONCILIATION_REQUIRED,
      mayCallProvider: false,
      reason: "Another caller recorded this attempt first. Its outcome is not yet known.",
    };
  }
}

/**
 * Validate the objects a result claims, inventing nothing.
 *
 * ── THE SERVICE MANUFACTURED TWO FACTS, AND BOTH MATTERED ──────────────────
 * A missing `origin` defaulted to `created`, so an object a reconciliation merely
 * FOUND was recorded as one GRAV made. A missing state-read time defaulted to now, so
 * "we confirmed it stopped" carried a timestamp for a read that never happened.
 *
 * Both are refused. Evidence is either supplied or absent; a default is a fabricated
 * observation, and this record exists to be trusted.
 *
 * A third fabrication is refused here too: every object used to be asked whether it
 * was "confirmed paused", including objects with no delivery state. See
 * `deliveryStateApplies` below.
 */
function assertObjects(objects, { outcome }) {
  if (objects === null || objects === undefined) return [];
  if (!Array.isArray(objects)) {
    throw fail("VALIDATION", "objects must be a list.", { field: "objects" });
  }

  return objects.map((raw, index) => {
    const at = `objects.${index}`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw fail("VALIDATION", "Each object must be an object.", { field: at });
    }

    const role = str(raw.role);
    if (!OBJECT_ROLES.includes(role)) {
      throw fail("VALIDATION", `Each object needs a role: ${OBJECT_ROLES.join(", ")}.`, { field: `${at}.role` });
    }

    const providerObjectId = str(raw.providerObjectId);
    if (!providerObjectId) {
      throw fail("VALIDATION",
        "Each object needs the identifier the channel gave it. An object GRAV cannot name is one nobody can find.",
        { field: `${at}.providerObjectId` });
    }

    /* ── EXPLICIT, ALWAYS ───────────────────────────────────────────────────
       Created and observed are different claims. Defaulting to created turns a
       recovery into a deployment in the record. */
    const origin = str(raw.origin);
    if (!OBJECT_ORIGINS.includes(origin)) {
      throw fail("VALIDATION",
        `Each object must say whether GRAV created it or merely observed it: ${OBJECT_ORIGINS.join(" or ")}.`,
        { field: `${at}.origin` });
    }

    /* ── DOES A DELIVERY STATE EVEN APPLY? ──────────────────────────────────
       A campaign budget is a money object with no status saying whether anything is
       being shown. Asking it "were you confirmed paused" has no true answer: false
       reads as "we checked and it is running", and true is a fabrication. So the
       question is asked in two parts, and the first part is required. */
    const deliveryStateApplies = raw.deliveryStateApplies;
    if (typeof deliveryStateApplies !== "boolean") {
      throw fail("VALIDATION",
        "Each object must say whether a delivery state applies to it. A budget has none; a campaign does.",
        { field: `${at}.deliveryStateApplies` });
    }

    const nonDelivering = raw.nonDeliveringConfirmed;
    const readAt = asDate(raw.stateReadAt);

    /* ── AN EXCLUSION CANNOT BE CONFIRMED WITHOUT BEING CLAIMED ─────────────
       `negativeConfirmed` says a READ found this criterion stored the way GRAV
       asked. Recording that without saying which way GRAV asked is a confirmation
       of nothing, and it would read as "the exclusion is in place". */
    if (typeof raw.negativeConfirmed === "boolean" && typeof raw.negative !== "boolean") {
      throw fail("VALIDATION",
        "An object cannot be recorded as confirmed targeted or excluded without saying which GRAV asked for.",
        { field: `${at}.negative` });
    }

    if (!deliveryStateApplies) {
      /* Nothing may be claimed about a state this object does not have. */
      if (nonDelivering !== undefined && nonDelivering !== null) {
        throw fail("VALIDATION",
          "This object has no delivery state, so it cannot be recorded as delivering or not delivering.",
          { field: `${at}.nonDeliveringConfirmed` });
      }
      if (raw.stateReadAt !== undefined && raw.stateReadAt !== null) {
        throw fail("VALIDATION",
          "This object has no delivery state, so there is no state read to timestamp.",
          { field: `${at}.stateReadAt` });
      }
    } else {
      if (typeof nonDelivering !== "boolean") {
        throw fail("VALIDATION",
          "Each delivery-capable object must say whether it was read back as not delivering. This is evidence, not a default.",
          { field: `${at}.nonDeliveringConfirmed` });
      }
      if (nonDelivering && !readAt) {
        throw fail("VALIDATION",
          "An object confirmed not delivering needs the time its state was read. Without it, the confirmation is a claim with no observation behind it.",
          { field: `${at}.stateReadAt` });
      }
      if (!nonDelivering && raw.stateReadAt !== undefined && raw.stateReadAt !== null && !readAt) {
        throw fail("VALIDATION", "That is not a time GRAV can read.", { field: `${at}.stateReadAt` });
      }
    }

    return {
      role,
      providerObjectId,
      providerObjectType: str(raw.providerObjectType),
      origin,
      deliveryStateApplies,
      nonDeliveringConfirmed: deliveryStateApplies ? nonDelivering : null,
      stateReadAt: deliveryStateApplies ? (readAt || null) : null,
      observedState: str(raw.observedState),
      displayName: str(raw.displayName),
      requestedName: str(raw.requestedName),
      negative: typeof raw.negative === "boolean" ? raw.negative : null,
      negativeConfirmed: typeof raw.negativeConfirmed === "boolean" ? raw.negativeConfirmed : null,
      at: asDate(raw.at) || undefined,
    };
  });
}

/**
 * Refuse an outcome that does not match the evidence beside it.
 *
 * Each rule exists because the alternative reading is one somebody would act on.
 */
function assertOutcomeShape({ outcome, objects }) {
  if (!OUTCOMES.includes(str(outcome))) {
    throw fail("VALIDATION", `An outcome must be one of: ${OUTCOMES.join(", ")}.`, { field: "outcome" });
  }

  /* ── ONLY THE OBJECTS THAT CAN DELIVER ARE ASKED ────────────────────────
     And there has to be at least one: a set of supporting objects alone has
     confirmed nothing about whether anything could be shown. */
  const deliveryCapable = objects.filter((o) => o.deliveryStateApplies === true);
  const confirmed = deliveryCapable.length > 0
    && deliveryCapable.every((o) => o.nonDeliveringConfirmed === true);

  /* ── THE SECOND THING A SUCCESS HAS TO BE ───────────────────────────────
     "Stopped" is not the only question. A targeting criterion — a location, a
     language — carries `negative`, and an EXCLUSION that the account stored as
     an INCLUSION is a campaign that will run in the one place somebody said to
     avoid. Nothing in a create response shows it and nothing on a provider
     screen looks wrong, so it has to be read back and it has to count.

     Objects with no `negative` are not asked. An attempt made entirely of them
     is `targetingConfirmed` vacuously, which is correct: a deployment with no
     targeting criteria has no targeting to have got wrong. */
  const criteria = objects.filter((o) => typeof o.negative === "boolean");
  const targetingConfirmed = criteria.every((o) => o.negativeConfirmed === true);

  if (outcome === "succeeded") {
    if (!objects.length) {
      throw fail("VALIDATION",
        "A successful attempt created something. An outcome of succeeded with no objects records a success nobody can point at.",
        { field: "objects" });
    }
    if (!deliveryCapable.length) {
      throw fail("VALIDATION",
        "A successful attempt created at least one object that can deliver, and checked it. Supporting objects alone confirm nothing about whether anything could be shown.",
        { field: "objects" });
    }
    if (!confirmed) {
      throw fail("VALIDATION",
        "A successful attempt has every delivery-capable object read back and confirmed not delivering. Anything less is partial, and calling it success hides an object that may be able to deliver.",
        { field: "objects" });
    }
    if (!targetingConfirmed) {
      throw fail("VALIDATION",
        "A successful attempt has every location and language read back and confirmed stored the way it was sent. Anything less is partial, and calling it success hides a campaign that may run somewhere nobody chose.",
        { field: "objects" });
    }
  }

  if (outcome === "partially_created") {
    if (!objects.length) {
      throw fail("VALIDATION",
        "A partial attempt created or observed something. With no objects it is a failure, not a partial one.",
        { field: "objects" });
    }
    /* ── PARTIAL MUST NOT LOOK LIKE COMPLETE SUCCESS ───────────────────────
       Every object created, at least one able to deliver, and every one of those
       confirmed not delivering IS success. Recording it as partial would send
       somebody to reconcile an account where nothing is outstanding. */
    if (confirmed && targetingConfirmed && objects.every((o) => o.origin === "created")) {
      throw fail("VALIDATION",
        "Every object was created, every delivery-capable one confirmed not delivering and every location and language confirmed as sent, which is a complete success rather than a partial one.",
        { field: "outcome" });
    }
  }

  if (outcome === "refused_preflight" && objects.length) {
    throw fail("VALIDATION",
      "An attempt refused at preflight created nothing, so it carries no external objects.",
      { field: "objects" });
  }

  /* `failed` deliberately MAY carry objects. A failure that created a budget and
     then stopped must record the budget — hiding it is how an orphan is left in an
     advertising account with nothing pointing at it. */

  /* Only the delivery rollup is returned — it is the one the record stores. The
     targeting confirmation lives per-object, because "which exclusion went
     wrong" is the question somebody reconciling actually has. */
  return confirmed;
}

/* The semantic identity of a settlement: what it says happened, and nothing GRAV
   generated when writing it. Two identical settlements a second apart are one
   settlement, and a generated timestamp would make them look different. */
const resultFingerprintOf = ({ outcome, reasonCode, operatorNote, objects }) => crypto
  .createHash("sha256")
  .update(stableJson({
    outcome: str(outcome),
    reasonCode: str(reasonCode),
    operatorNote: str(operatorNote),
    objects: objects.map((o) => ({
      role: o.role,
      providerObjectId: o.providerObjectId,
      providerObjectType: o.providerObjectType,
      origin: o.origin,
      deliveryStateApplies: o.deliveryStateApplies,
      nonDeliveringConfirmed: o.nonDeliveringConfirmed,
      /* Part of the settlement's identity: the same attempt settled once with an
         exclusion confirmed and once without is not the same settlement. */
      negative: o.negative,
      negativeConfirmed: o.negativeConfirmed,
      /* Supplied evidence, so part of the identity — unlike `at`, which GRAV
         defaults. */
      stateReadAt: o.stateReadAt ? o.stateReadAt.toISOString() : null,
      observedState: o.observedState,
    })),
  }))
  .digest("hex")
  .slice(0, 64);

/**
 * Record how an attempt ended.
 *
 * ── EXACTLY ZERO OR ONE RESULT PER INTENT, AND A RETRY IS NOT A SECOND ─────
 * A settlement whose response was lost is retried with the same facts, and that must
 * return the existing result rather than conflicting — a caller doing exactly the
 * right thing should not be told it failed. A settlement with DIFFERENT facts for one
 * intent is a conflict: two accounts of one attempt would make the record unreadable,
 * and the first is the one written closest to the event.
 */
async function settle({
  companyId, intentId, outcome, reasonCode, operatorNote = "", objects = [], now = new Date(),
}) {
  const company = toObjectId(companyId, "companyId");
  const intentKey = toObjectId(intentId, "intentId");

  if (!isSuppliedText(reasonCode)) {
    throw fail("VALIDATION",
      "A settlement needs a GRAV reason code, so an operator reading it later knows why without a provider message.",
      { field: "reasonCode" });
  }

  const settled = assertObjects(objects, { outcome });
  const deliveryObjectsNonDeliveringConfirmed = assertOutcomeShape({ outcome, objects: settled });
  const resultFingerprint = resultFingerprintOf({ outcome, reasonCode, operatorNote, objects: settled });

  /* Company-scoped, like every selector in this domain. A result may only settle an
     intent the asking company owns. */
  const intent = await MarketingCampaignDeploymentAttemptIntent
    .findOne({ _id: intentKey, companyId: company }).lean();

  if (!intent) {
    throw fail("NOT_FOUND",
      "There is no recorded attempt for this company to settle.",
      { field: "intentId" });
  }

  try {
    const result = await MarketingCampaignDeploymentAttemptResult.create({
      companyId: company,
      intentId: intent._id,
      deploymentId: intent.deploymentId,
      attemptNo: intent.attemptNo,
      finishedAt: now,
      outcome,
      reasonCode: str(reasonCode),
      operatorNote: str(operatorNote),
      objects: settled.map((o) => ({ ...o, at: o.at || now })),
      resultFingerprint,
      deliveryObjectsNonDeliveringConfirmed,
    });
    return { result, created: true, duplicate: false };
  } catch (err) {
    if (err?.code !== 11000) throw err;

    const existing = await MarketingCampaignDeploymentAttemptResult
      .findOne({ companyId: company, intentId: intent._id });

    if (existing && existing.resultFingerprint === resultFingerprint) {
      /* The same settlement, retried after a lost response. */
      return { result: existing, created: false, duplicate: true };
    }

    throw fail("CONFLICT",
      "This attempt has already been settled with a different account of what happened. An attempt has one account of how it ended, and it is the one written closest to the event.",
      { field: "intentId" });
  }
}

/**
 * Every attempt on a deployment, each with its result or an honest unknown.
 *
 * ── AN UNRESOLVED ATTEMPT IS A QUESTION, NOT AN ANSWER ─────────────────────
 * `resolved: false` means GRAV recorded that the attempt started and does not know
 * how it ended. It does NOT mean failed, it does NOT mean safe to retry, and it is
 * NOT evidence that nothing was created — objects may exist in the advertising
 * account that GRAV has no record of.
 *
 * The shape says so in its own fields rather than leaving a reader to infer it from
 * a null, because a null is exactly what somebody would read as "nothing happened".
 */
async function attemptsFor({ companyId, deploymentId }) {
  const company = toObjectId(companyId, "companyId");
  const deployment = toObjectId(deploymentId, "deploymentId");

  const [intents, results] = await Promise.all([
    MarketingCampaignDeploymentAttemptIntent
      .find({ companyId: company, deploymentId: deployment }).sort({ attemptNo: 1 }).lean(),
    MarketingCampaignDeploymentAttemptResult
      .find({ companyId: company, deploymentId: deployment }).lean(),
  ]);

  const resultFor = new Map(results.map((r) => [String(r.intentId), r]));

  return intents.map((intent) => {
    const result = resultFor.get(String(intent._id)) || null;

    if (result) {
      return {
        attemptNo: intent.attemptNo,
        startedAt: intent.startedAt,
        requestedBy: { name: intent.requestedBy?.name || "" },
        resolved: true,
        outcome: result.outcome,
        finishedAt: result.finishedAt,
        reasonCode: result.reasonCode,
        operatorNote: result.operatorNote || "",
        deploymentMarker: intent.deploymentMarker || "",
        objects: result.objects || [],
        deliveryObjectsNonDeliveringConfirmed: result.deliveryObjectsNonDeliveringConfirmed === true,
      };
    }

    return {
      attemptNo: intent.attemptNo,
      startedAt: intent.startedAt,
      requestedBy: { name: intent.requestedBy?.name || "" },
      resolved: false,
      /* Deliberately null, and deliberately accompanied by the sentence below. A
         bare null invites "nothing happened"; these fields say what the null means. */
      outcome: null,
      finishedAt: null,
      means: "GRAV recorded that this attempt started and does not yet know how it ended.",
      mustNotBeReadAs: [
        "failed",
        "safe to retry",
        "proof that nothing was created",
      ],
      requiresReconciliation: true,
      reconciliationNote: "Objects may exist in the advertising account that GRAV has no record of. The account must be reconciled against this attempt before another external creation is attempted.",
      /* ── HOW TO GO AND LOOK ────────────────────────────────────────────
         The marker is the only thing that can answer "did this request take
         effect", so an unresolved attempt carries it. Without it this row says
         a person must reconcile and gives them nothing to reconcile WITH. */
      deploymentMarker: intent.deploymentMarker || "",
      plannedSummary: intent.plannedSummary || { objectCount: 0, objectRoles: [] },
    };
  });
}

/**
 * Is there an unresolved attempt on this deployment?
 *
 * The question a future deployment writer has to ask before starting anything. A
 * `true` here means a human or a reconciliation step has to look at the advertising
 * account first — retrying on top of an unresolved attempt is how duplicate
 * campaigns are created.
 */
async function hasUnresolvedAttempt({ companyId, deploymentId }) {
  const attempts = await attemptsFor({ companyId, deploymentId });
  const unresolved = attempts.filter((a) => !a.resolved);
  return { unresolved: unresolved.length > 0, attempts: unresolved };
}

module.exports = {
  DISPOSITIONS,
  OUTCOMES,
  OBJECT_ORIGINS,
  begin,
  settle,
  attemptsFor,
  hasUnresolvedAttempt,
  allocateAttemptNumber,
  fingerprintOf,
  commandFingerprintOf,
  resultFingerprintOf,
  normaliseCommand,
  stableJson,
};
