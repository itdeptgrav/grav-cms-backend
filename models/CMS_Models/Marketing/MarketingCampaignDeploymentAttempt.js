// models/CMS_Models/Marketing/MarketingCampaignDeploymentAttempt.js
//
// A DEPLOYMENT ATTEMPT, AS TWO APPEND-ONLY FACTS. NOTHING WRITES ONE YET.
//
// ── THE CONTRADICTION THIS RESOLVES ────────────────────────────────────────
// The previous single-document attempt was immutable and required its final facts
// at creation: outcome, finish time, created objects, evidence. Those facts do not
// exist before the external request starts, and after it finishes the immutable row
// cannot be changed to record them. The record could only ever be written at a
// moment when it was impossible to write truthfully.
//
// Creating it only AFTERWARDS is worse, and is the reason this shape matters at
// all: a process that calls a provider and crashes before recording anything has
// created real advertising objects that GRAV has no record of. Nobody would know to
// look for them, and the next retry would create a second set.
//
// ── SO: INTENT FIRST, RESULT SECOND, BOTH IMMUTABLE ────────────────────────
//
//   INTENT   written and confirmed BEFORE any external request. It says what is
//            about to be attempted, by whom, under whose authority, against which
//            approved plan revision. It contains NO claimed outcome, because none
//            exists yet.
//
//   RESULT   written after the external interaction. It says how it ended, what was
//            observed or created, and what was read back. Exactly zero or one may
//            exist per intent.
//
// ── AND A MISSING RESULT MEANS EXACTLY ONE THING ───────────────────────────
// "GRAV recorded that this attempt started and does not yet know how it ended."
//
// It does NOT mean failed. It does NOT mean safe to retry. It does NOT mean nothing
// was created. An unresolved intent is the signal that somebody — or a
// reconciliation step — must go and look at the advertising account before anything
// else is attempted, because objects may exist that GRAV cannot see in its own
// records.
//
// That asymmetry is the whole point: an intent with no result is a question, and a
// system that treated it as an answer would create duplicate campaigns.
"use strict";

const mongoose = require("mongoose");

const {
  RECORDABLE_CAMPAIGN_TYPES: SUPPORTED_CAMPAIGN_TYPES, RECORDABLE_CAMPAIGN_TYPE_CODES: SUPPORTED_CAMPAIGN_TYPE_CODES, CHANNEL_SUPPORT,
} = require("../../../constants/marketingDeploymentReadiness");

const DEPLOYMENT_CHANNEL_CODES = Object.freeze(Object.keys(CHANNEL_SUPPORT));

/* ── THE ATTEMPT-NUMBER COUNTER ──────────────────────────────────────────────
   One document per deployment, advanced with `$inc`, which is the only atomicity
   MongoDB offers without a transaction.

   NOT `count + 1`, and not "read the newest and add one". Both read a value that a
   concurrent caller is about to change, so two attempts can compute the same
   number — and the unique fence below then rejects one of them AFTER it may already
   have started an external request. The number has to be allocated before anything
   external happens, and it has to be allocated atomically.

   A consumed number may leave a gap: a caller that takes 3 and then fails leaves 3
   unused. That is acceptable and it is recorded here so nobody "fixes" it. An
   attempt number is an identity, not a count of attempts, and reclaiming one would
   mean two different attempts could be called the third. */
const attemptCounterSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true },
    deploymentId: { type: mongoose.Schema.Types.ObjectId, required: true },
    seq: { type: Number, required: true, default: 0, min: 0 },
  },
  { timestamps: true, collection: "marketing_campaign_deployment_attempt_counters" },
);

attemptCounterSchema.index({ companyId: 1, deploymentId: 1 }, { unique: true });

/* ── THE INTENT ──────────────────────────────────────────────────────────────
   Everything knowable before the external request, and nothing else. */
const intentSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true },
    deploymentId: { type: mongoose.Schema.Types.ObjectId, required: true },

    /* Allocated atomically from the counter above. */
    attemptNo: { type: Number, required: true, min: 1 },

    /* ── THE COMMAND IDENTITY ────────────────────────────────────────────────
       What makes one logical retry the SAME attempt rather than a second one. A
       caller that retries under the same command identity finds this intent and its
       number; a genuinely new attempt carries a different identity and takes the
       next number.

       Without it, a retry after a dropped connection would allocate a fresh number
       and start a second external request — which is precisely the duplicate the
       whole protocol exists to prevent. */
    commandKey: { type: String, required: true, trim: true, maxlength: 128 },

    /* The exact plan revision this attempt is of. A plan edited afterwards is a
       different document, and an attempt that could not name its revision would be
       an audit of nothing. */
    approvedRevision: { type: Number, required: true, min: 1 },

    channel: { type: String, enum: DEPLOYMENT_CHANNEL_CODES, required: true },
    campaignType: { type: String, enum: SUPPORTED_CAMPAIGN_TYPE_CODES, required: true },

    /* ── WHO, AND UNDER WHOSE AUTHORITY ──────────────────────────────────────
       An id rather than a display name on both, because a name is a snapshot and an
       id is an identity. A deployment attempt spends somebody's money; an anonymous
       one is not acceptable, and neither is one whose authorisation has no time
       against it. */
    requestedBy: {
      id: { type: mongoose.Schema.Types.ObjectId, required: true },
      name: { type: String, trim: true, default: "" },
      role: { type: String, trim: true, default: "" },
    },
    authorizedBy: {
      id: { type: mongoose.Schema.Types.ObjectId, required: true },
      name: { type: String, trim: true, default: "" },
      at: { type: Date, required: true },
    },

    startedAt: { type: Date, required: true, default: Date.now },

    /* ── WHAT WAS ABOUT TO BE ATTEMPTED ──────────────────────────────────────
       A fingerprint of the mapped objects, plus a safe summary. NOT the provider
       payload: that would put provider shapes into a GRAV record, and the payload is
       reconstructible from the plan revision named above.

       The fingerprint is what lets a reconciliation tell whether an unresolved
       intent was for the same thing a retry is about to do. */
    plannedFingerprint: { type: String, required: true, trim: true, maxlength: 128 },

    /* ── THE FINGERPRINT OF THE WHOLE COMMAND ────────────────────────────────
       `commandKey` alone identified a retry, so the same key could be reused with a
       different approved revision, channel, campaign type, planned objects,
       requester or authorisation and be accepted as "the same attempt". It is not:
       it is a different command wearing a used name, and returning the earlier
       intent for it would authorise an external request nobody described.

       This covers every field the command decided, so a retry is recognised by what
       it IS rather than by what it is called. */
    commandFingerprint: { type: String, required: true, trim: true, maxlength: 128 },

    /* ── THE MARK GRAV PUT ON THE CAMPAIGN ───────────────────────────────────
       Derived from this command's immutable identity BEFORE the request was made
       and stored here, so that a process which dies mid-flight leaves behind the
       one string that can find what it may have created. A campaign name cannot
       do this job: names are not unique, a removed campaign keeps its name, and
       anybody with account access can type one by hand. */
    deploymentMarker: { type: String, required: true, trim: true, maxlength: 80 },

    plannedSummary: {
      /* Counts, not contents. Enough for an operator to know what to look for in the
         advertising account. */
      objectCount: { type: Number, default: 0, min: 0 },
      objectRoles: { type: [String], default: [] },
    },
  },
  { collection: "marketing_campaign_deployment_attempt_intents" },
);

/* One intent per attempt number per deployment. */
intentSchema.index({ companyId: 1, deploymentId: 1, attemptNo: 1 }, { unique: true });

/* ── AND ONE INTENT PER COMMAND IDENTITY ─────────────────────────────────────
   The fence that makes a retry idempotent: a second attempt under the same command
   identity collides here and the caller reads the existing intent rather than
   allocating a new number and starting a second external request. */
intentSchema.index({ companyId: 1, deploymentId: 1, commandKey: 1 }, { unique: true });

/* Operator reads: what is outstanding in this company. */
intentSchema.index({ companyId: 1, startedAt: -1 });

/* ── THE RESULT ──────────────────────────────────────────────────────────────
   Everything knowable only after the external interaction. */

/* One object GRAV observed or created, and what it was read back as. */
const observedObjectSchema = new mongoose.Schema(
  {
    role: {
      type: String,
      /* ── GRAV'S ROLES, NOT A PROVIDER'S ──────────────────────────────────
         `targeting_term` is a Google keyword and a Meta detailed-targeting
         entry: the same rung of two different ladders, so one GRAV word and
         the provider's own term recorded beside it. */
      enum: ["budget", "campaign", "audience_group", "creative", "advertisement", "targeting_term",
        /* Targeting rules on a campaign. They have no delivery state — the
           campaign's status decides that — and `location_target` is kept apart
           from `language_target` so evidence can show that an excluded place was
           stored as an exclusion. */
        "location_target", "language_target",
        /* A Google lead form and its link to the campaign. The link has a
           status of its own (PAUSED at creation); the form itself has none. */
        "lead_form", "lead_form_link"],
      required: true,
    },
    /* The provider's own id. This and the deployment's rollup are the only places
       one is ever stored. */
    providerObjectId: { type: String, required: true, trim: true },
    providerObjectType: { type: String, trim: true, default: "" },

    /* ── CREATED, OR MERELY FOUND ────────────────────────────────────────────
       A reconciliation that discovers an object a crashed attempt left behind is
       recording something it OBSERVED, not something it created. Collapsing the two
       would make a recovery look like a deployment. */
    origin: { type: String, enum: ["created", "observed"], required: true },

    /* ── NOT EVERY OBJECT HAS A DELIVERY STATE ───────────────────────────────
       A campaign budget is a shared money object. It has no status that says whether
       anything is being shown, and it cannot be paused. The earlier contract asked
       every object whether it was "confirmed paused", so a budget could only be
       recorded as false — which reads as "we checked and it is running" — or
       fabricated as true. Both are lies about an object that has no such state.

       So each object first says whether a delivery state applies to it at all, and
       only the ones where it does are asked what that state was. */
    deliveryStateApplies: { type: Boolean, required: true },

    /* ── WHAT THE AUTHOR ASKED FOR, BESIDE WHAT THE CHANNEL CALLS IT ─────────
       A criterion id is unreadable. Somebody reconciling a half-created campaign
       needs "India", not "2356", and needs to see the word they typed next to the
       one the channel resolved it to. */
    displayName: { type: String, trim: true, default: "", maxlength: 300 },
    requestedName: { type: String, trim: true, default: "", maxlength: 300 },

    /* ── TARGETED, OR AVOIDED ────────────────────────────────────────────────
       Null where the question does not apply — a budget, a campaign, an ad. For a
       location criterion it is the whole point: `negative` is what separates "run
       here" from "never run here", and the two are one dropped boolean apart.

       `negativeConfirmed` is the separate READ, like `nonDeliveringConfirmed`: the
       create response says what GRAV sent, not what the account holds. An
       exclusion that arrived as an inclusion is not a success, and this is the
       field that makes that detectable instead of invisible. */
    negative: { type: Boolean, default: null },
    negativeConfirmed: { type: Boolean, default: null },


    /* ── READ BACK, NOT ASSUMED ──────────────────────────────────────────────
       A create that returned 200 is not a non-delivering object. Set only after a
       separate read, and `stateReadAt` says when that read happened. Null — not
       false — where a delivery state does not apply, because false would be an
       answer to a question that was never asked. */
    nonDeliveringConfirmed: { type: Boolean, default: null },
    stateReadAt: { type: Date, default: null },
    /* What the read actually returned, in the provider's own word, so an operator
       reconciling against the advertising interface sees the same thing. */
    observedState: { type: String, trim: true, default: "" },

    at: { type: Date, required: true, default: Date.now },
  },
  { _id: false },
);

const resultSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true },

    /* The intent this settles, by its own id and by its attempt identity. Both,
       because the id is the join and the attempt identity is what an operator reads. */
    intentId: { type: mongoose.Schema.Types.ObjectId, required: true },
    deploymentId: { type: mongoose.Schema.Types.ObjectId, required: true },
    attemptNo: { type: Number, required: true, min: 1 },

    finishedAt: { type: Date, required: true, default: Date.now },

    /* ── PARTIAL IS ITS OWN OUTCOME ──────────────────────────────────────────
       `partially_created` is not a kind of failure. A failed attempt may have left
       nothing; a partial one certainly left something, and the two demand different
       recovery. Recording a partial as a failure invites a retry that duplicates. */
    outcome: {
      type: String,
      enum: ["succeeded", "partially_created", "failed", "refused_preflight"],
      required: true,
    },

    /* GRAV's own code. Never the provider's message: that belongs in the server log,
       and a caller must not learn a provider's error taxonomy. */
    reasonCode: { type: String, required: true, trim: true, maxlength: 64 },
    /* A sentence for an operator, already scrubbed of provider text by the service
       that writes it. */
    operatorNote: { type: String, trim: true, default: "", maxlength: 1000 },

    /* Every object observed or created, immutable with this row. */
    objects: { type: [observedObjectSchema], default: [] },

    /* ── THE SEMANTIC FINGERPRINT OF THIS RESULT ─────────────────────────────
       What makes a lost-response retry idempotent. Covers the outcome, the reason,
       the operator note and every object's evidence — and deliberately NOT the
       timestamps GRAV generates when the row is written, because two identical
       settlements a second apart are the same settlement and a generated time would
       make them look different. */
    resultFingerprint: { type: String, required: true, trim: true, maxlength: 128 },

    /* ── THE CLAIM WORTH MAKING, NAMED FOR WHAT IT IS ────────────────────────
       `allPausedConfirmed` was a misleading name: it could never be true for a set
       containing a budget, and making it true would have meant claiming a budget was
       paused. This says the accurate thing instead — every object that CAN deliver
       was read back and confirmed not delivering — and it requires at least one such
       object, because a set with nothing delivery-capable in it has confirmed
       nothing. */
    deliveryObjectsNonDeliveringConfirmed: { type: Boolean, required: true, default: false },
  },
  { collection: "marketing_campaign_deployment_attempt_results" },
);

/* ── EXACTLY ZERO OR ONE RESULT PER INTENT ───────────────────────────────────
   Zero is a legitimate, meaningful state. One is settled. Two is impossible. */
resultSchema.index({ companyId: 1, intentId: 1 }, { unique: true });
resultSchema.index({ companyId: 1, deploymentId: 1, attemptNo: 1 }, { unique: true });

/* ═══ MUTATION PROTECTION ════════════════════════════════════════════════════

   ── EVERY MODEL-LEVEL PATH, INCLUDING bulkWrite ────────────────────────────
   The previous version blocked the update and delete families and the save hook,
   and omitted `bulkWrite` — which can carry `updateOne`, `updateMany`,
   `replaceOne`, `deleteOne` and `deleteMany` operations and does not run any of
   those hooks. One `bulkWrite` could have rewritten or removed an immutable row
   with nothing objecting.

   `insertOne` inside a bulk write is allowed, for the same reason plain inserts
   are: insertion is how an append-only fact is recorded.

   ── AND WHAT THIS DOES NOT PROTECT ─────────────────────────────────────────
   Mongoose middleware cannot see `Model.collection.*`, which reaches the driver
   directly. That is not a hole this file can close, and pretending otherwise would
   be exactly the false guarantee the embedded-attempt version made. The real
   boundary is: all future writes go through one dedicated service, and a structural
   test asserts that no Marketing service or route touches `.collection` for these
   records. The model enforces what a model can; the service boundary does the rest. */
const MUTATING_QUERY_OPS = [
  "updateOne", "updateMany", "findOneAndUpdate", "findOneAndReplace", "replaceOne",
  "deleteOne", "deleteMany", "findOneAndDelete", "findOneAndRemove",
];

const BULK_MUTATING_OPS = ["updateOne", "updateMany", "replaceOne", "deleteOne", "deleteMany"];

function protectAppendOnly(schema, collectionName) {
  const refuse = function refuseMutation(next) {
    next(new Error(`${collectionName} is append-only: a recorded fact cannot be updated or deleted.`));
  };

  for (const op of MUTATING_QUERY_OPS) schema.pre(op, refuse);

  /* A bulk write is refused only when it CONTAINS a mutating operation. A bulk of
     pure inserts is how several facts are appended at once. */
  schema.pre("bulkWrite", function refuseBulkMutation(next, ops) {
    const operations = Array.isArray(ops) ? ops : [];
    const offending = operations
      .flatMap((op) => Object.keys(op || {}))
      .filter((name) => BULK_MUTATING_OPS.includes(name));

    if (offending.length) {
      return next(new Error(
        `${collectionName} is append-only: a bulk write may not contain ${[...new Set(offending)].join(", ")}.`,
      ));
    }
    return next();
  });

  schema.pre("save", function refuseResave(next) {
    if (!this.isNew) {
      return next(new Error(`${collectionName} is append-only: an existing record cannot be re-saved.`));
    }
    return next();
  });
}

protectAppendOnly(intentSchema, "marketing_campaign_deployment_attempt_intents");
protectAppendOnly(resultSchema, "marketing_campaign_deployment_attempt_results");

/* The channel and the campaign type must agree on an intent too: it is the record a
   future deployment reads to know what it is creating. */
intentSchema.pre("validate", function channelAndTypeAgree(next) {
  const spec = SUPPORTED_CAMPAIGN_TYPES.find((t) => t.code === this.campaignType);
  if (!spec) {
    return next(new Error(`marketing_campaign_deployment_attempt_intents: ${this.campaignType} is not a campaign type GRAV deploys.`));
  }
  if (spec.channel !== this.channel) {
    return next(new Error(
      `marketing_campaign_deployment_attempt_intents: ${spec.label} is a ${spec.channel} campaign type and this intent names ${this.channel}.`,
    ));
  }
  return next();
});

const MarketingCampaignDeploymentAttemptCounter = mongoose.models.MarketingCampaignDeploymentAttemptCounter
  || mongoose.model("MarketingCampaignDeploymentAttemptCounter", attemptCounterSchema);

const MarketingCampaignDeploymentAttemptIntent = mongoose.models.MarketingCampaignDeploymentAttemptIntent
  || mongoose.model("MarketingCampaignDeploymentAttemptIntent", intentSchema);

const MarketingCampaignDeploymentAttemptResult = mongoose.models.MarketingCampaignDeploymentAttemptResult
  || mongoose.model("MarketingCampaignDeploymentAttemptResult", resultSchema);

module.exports = {
  MarketingCampaignDeploymentAttemptCounter,
  MarketingCampaignDeploymentAttemptIntent,
  MarketingCampaignDeploymentAttemptResult,
  DEPLOYMENT_CHANNEL_CODES,
  BULK_MUTATING_OPS,
};
