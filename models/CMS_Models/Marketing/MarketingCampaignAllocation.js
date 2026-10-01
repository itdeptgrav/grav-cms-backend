// models/CMS_Models/Marketing/MarketingCampaignAllocation.js
//
// THE THREE THINGS A CAMPAIGN PLAN MUST CLAIM BEFORE IT HAS A HISTORY.
//
// ── THE FLAW THESE CLOSE ───────────────────────────────────────────────────
// The history-first protocol serialises revisions WITHIN one plan: the unique
// `(company, draft, revision)` index means two callers cannot both claim one
// revision of one plan. It says nothing about identities shared ACROSS plans.
//
// Two concurrent creates each mint their own `draftId`, so each reserves a
// perfectly valid history row — different drafts, same revision 1, no collision.
// Both rows then carry the same `draftRef`, or the same `utmCampaign`, because
// both derived it by reading the same state a moment earlier. The unique index on
// the current-plan collection rejects one projection, and the loser is left with
// canonical, append-only history that can NEVER be applied. Reconciliation will
// try for ever and fail every time.
//
// The fix is ordering: every shared identity is claimed in its own collection,
// atomically, BEFORE any history is written. A claim that cannot be had is an
// honest 409 at a point where nothing has been recorded yet.
//
//   marketing_campaign_ref_counters    the reference sequence, per company and year
//   marketing_campaign_identities      UTM campaign identities, permanently
//   marketing_campaign_create_intents  creation idempotency
"use strict";

const mongoose = require("mongoose");

/* ── THE REFERENCE COUNTER ───────────────────────────────────────────────────
   `MCP-2026-0001` used to be derived by reading the largest existing reference
   and adding one. Two concurrent creates read the same largest value and computed
   the same next one — a textbook lost allocation, and one that the unique index
   turned into unapplicable history rather than a clean retry.

   A counter document incremented with `$inc` is atomic in a single document, which
   is the one atomicity guarantee MongoDB gives without a transaction. Two callers
   therefore receive 4 and 5, never 4 and 4.

   ── GAPS ARE ACCEPTABLE; DUPLICATES ARE NOT ───────────────────────────────
   A caller that takes number 5 and then fails leaves 5 unused for ever. The
   sequence is a reference, not a count: nobody should read `MCP-2026-0007` as
   "the seventh plan", and nothing in the product does. Closing the gap would mean
   returning the number on failure, which is a second write that can itself fail,
   and a returned number two callers can then both take. A gap is a cosmetic cost;
   a duplicate reference is two plans that cannot both exist. */
const refCounterSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true },
    /* Scoped to the year as well as the company, because the reference restarts
       each year. A single counter per company would make 2027's first plan
       `MCP-2027-0493`. */
    year: { type: Number, required: true, min: 2000, max: 9999 },
    seq: { type: Number, required: true, default: 0, min: 0 },
  },
  { timestamps: true, collection: "marketing_campaign_ref_counters" },
);

/* One counter per company and year. The company leads, so two companies hold
   independent sequences and neither can infer the other's volume. */
refCounterSchema.index({ companyId: 1, year: 1 }, { unique: true });

/* ── THE UTM IDENTITY RESERVATION ────────────────────────────────────────────
   A separate collection rather than relying on the plan's own unique index, for
   one reason: the plan's index is checked when the plan is PROJECTED, which is
   after history is durable. By then a conflict is unrecoverable. This is checked
   before anything is recorded.

   ── A COMMITTED RESERVATION IS NEVER RELEASED ─────────────────────────────
   Once an accepted plan revision carries an identity, it is held for ever — not by
   cancelling the plan, not by rejecting it, and not by the plan later changing to a
   different one. The moment a plan has been deployed its identity exists in the
   channels' click data and in every analytics report covering that period; reusing
   it merges two unrelated campaigns into one plausible-looking row. A plan that
   changes its identity therefore holds both.

   ── A PROVISIONAL ONE IS NOT YET AN IDENTITY ──────────────────────────────
   The rule was applied too early. An edit claimed an identity, then lost the
   revision race, and the identity stayed reserved for ever by a plan that never
   adopted it — so a typo in a losing request permanently burned a name nobody ever
   used. A claim is `provisional` until the history revision that wanted it is
   accepted, and a claim whose revision provably never happened is resolved.

   Provisional claims still BLOCK, because an in-flight identity must not be
   stealable out from under a request that is still running. */
const identitySchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true },
    /* Stored exactly as the plan stores it: lower-cased and validated upstream. */
    utmCampaign: { type: String, required: true, trim: true, lowercase: true },

    /* Which plan owns it, and the revision that claimed it. The draft may not
       exist yet — that is the point of reserving first — so this is deliberately
       not a populated reference. */
    draftId: { type: mongoose.Schema.Types.ObjectId, required: true },
    draftRef: { type: String, trim: true, default: "" },
    claimedAtRevision: { type: Number, required: true, min: 1 },

    /* ── PROVISIONAL UNTIL THE REVISION THAT WANTED IT IS ACCEPTED ───────────
       "An identity is never released" is true of an identity an accepted plan
       revision actually carries. It was wrong as a blanket rule: an edit that
       claimed an identity and then LOST the revision race never adopted it, and
       holding it for ever meant a typo in a losing request permanently burned a
       name nobody ever used.

       So a claim starts `provisional`. It blocks other plans — an in-flight
       identity must not be stealable — and it becomes `committed` only when the
       history revision that wanted it is accepted. A claim whose revision provably
       never happened is resolved and the identity is free again. */
    status: { type: String, enum: ["provisional", "committed"], required: true, default: "provisional" },

    /* ── THE DURABLE COMMAND IDENTITY ───────────────────────────────────────
       Derived deterministically from the company, the plan, the revision and the
       identity, so a RETRY of the same interrupted edit regenerates the same token
       and recognises its own claim. Nothing is held in process memory and nothing
       depends on a clock, because both are exactly what an interrupted command
       cannot rely on.

       It is also what makes cleanup safe: a resolution keyed on this token cannot
       remove a claim belonging to a different, still-running request. */
    claimToken: { type: String, required: true, trim: true },

    committedAt: { type: Date, default: null },

    /* True while this is the plan's CURRENT identity. A plan that changes
       identity leaves the old row with `current: false`, so an operator can see
       the history of a plan's identities without reading the plan's own trail. */
    current: { type: Boolean, default: true },

    at: { type: Date, required: true, default: Date.now },
  },
  { collection: "marketing_campaign_identities" },
);

/* ── THE CONSTRAINT THAT DOES THE WORK ───────────────────────────────────────
   One owner per identity per company, for ever. Two concurrent claims: one
   insert succeeds, the other gets a duplicate key, and the loser is refused
   BEFORE it has written any history. */
identitySchema.index({ companyId: 1, utmCampaign: 1 }, { unique: true });
/* Every identity a plan has ever held, and the provisional ones first so a
   reconciliation can find what is outstanding without scanning. */
identitySchema.index({ companyId: 1, draftId: 1, status: 1 });
/* Resolving a claim by its own command identity. */
identitySchema.index({ companyId: 1, claimToken: 1 });

/* ── THE CREATION INTENT ─────────────────────────────────────────────────────
   Creation is the one command with no prior revision to be idempotent against. A
   retry after an interruption has nothing to recognise itself by, so without this
   it creates a second plan — a second reference, a second identity claim, a second
   history row — and the author sees two.

   So a create carries a caller-supplied key, and this row is the durable record of
   that intent. It is claimed FIRST, before the reference and before the identity,
   and it accumulates what each step allocated. A retry finds it and continues from
   wherever the previous attempt stopped.

   `payloadFingerprint` is what makes reuse safe: the same key with the same
   payload continues, and the same key with a DIFFERENT payload is refused rather
   than silently returning the first plan. A client that reuses a key for a new
   plan has a bug, and answering with somebody else's plan would hide it. */
const createIntentSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true },
    /* Strictly validated upstream: a bounded, printable token. Never a
       credential, and a test asserts the validator refuses one. */
    idempotencyKey: { type: String, required: true, trim: true, maxlength: 128 },

    /* SHA-256 of the canonical validated payload. A hash rather than the payload
       itself, because storing the payload would duplicate the plan and then drift
       from it. */
    payloadFingerprint: { type: String, required: true, trim: true },

    /* Allocated as the command proceeds. Each is written as soon as it is claimed,
       so a retry never re-claims one. */
    draftId: { type: mongoose.Schema.Types.ObjectId, required: true },
    draftRef: { type: String, trim: true, default: "" },
    utmCampaign: { type: String, trim: true, lowercase: true, default: "" },

    /* How far the previous attempt got. Advisory — every step is independently
       idempotent, so a wrong stage costs a redundant check and never a duplicate —
       and it is what makes an interrupted create legible to an operator. */
    stage: {
      type: String,
      enum: ["claimed", "reference_allocated", "identity_reserved", "history_reserved", "projected"],
      required: true,
      default: "claimed",
    },

    at: { type: Date, required: true, default: Date.now },
  },
  { timestamps: true, collection: "marketing_campaign_create_intents" },
);

/* One intent per key per company. Two concurrent requests carrying the same key:
   one claims, the other finds it and continues the same creation rather than
   starting a second. */
createIntentSchema.index({ companyId: 1, idempotencyKey: 1 }, { unique: true });
/* Resolving an intent from the plan it produced, for reconciliation. */
createIntentSchema.index({ companyId: 1, draftId: 1 });

const MarketingCampaignRefCounter = mongoose.models.MarketingCampaignRefCounter
  || mongoose.model("MarketingCampaignRefCounter", refCounterSchema);

const MarketingCampaignIdentity = mongoose.models.MarketingCampaignIdentity
  || mongoose.model("MarketingCampaignIdentity", identitySchema);

const MarketingCampaignCreateIntent = mongoose.models.MarketingCampaignCreateIntent
  || mongoose.model("MarketingCampaignCreateIntent", createIntentSchema);

module.exports = {
  MarketingCampaignRefCounter,
  MarketingCampaignIdentity,
  MarketingCampaignCreateIntent,
};
