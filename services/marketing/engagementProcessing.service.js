// services/marketing/engagementProcessing.service.js
//
// WHAT HAPPENS AFTER AN OBSERVATION IS RECORDED.
//
// ── THE ORDER IS THE SAFETY PROPERTY ───────────────────────────────────────
//   1. the immutable event is already written (the caller did that)
//   2. resolve identity
//   3. apply suppression, if the event is a withdrawal
//   4. project a CRM Activity, if the event is a milestone
//   5. record what was done on the receipt
//
// Suppression BEFORE projection, always. If the two were the other way round a
// crash between them would leave a "they unsubscribed" note on the timeline and
// no actual suppression — the worst of both, because the record says handled
// and the person keeps receiving mail.
//
// ── ACKNOWLEDGING IS NOT THE SAME AS FINISHING ─────────────────────────────
// A suppression that fails leaves the receipt SUPPRESSION_FAILED and the
// webhook still answers 200, because Mautic retrying the delivery would only
// re-record an event we already have. What must not happen — and does not — is
// the receipt saying RECORDED as though nothing were owed. The failure is
// visible in Data Health and `resumeUnfinished` retries it.
//
// ── AND SUPPRESSION IS NEVER WEAKENED BY ANYTHING THAT ARRIVES LATER ───────
// An open that occurred before an unsubscribe may arrive after it. It is
// recorded, and it changes nothing: the only writer of consent is the canonical
// consent service, nothing here calls it except for a withdrawal, and there is
// no code path anywhere in this module that un-suppresses.
"use strict";

const crypto = require("crypto");

const MarketingIdentity = require("../../models/CMS_Models/Marketing/MarketingIdentity");
const MarketingEventReceipt = require("../../models/CMS_Models/Marketing/MarketingEventReceipt");
const consentService = require("./marketingConsent.service");
const activityProjection = require("./crmActivityProjection.service");
const { fail } = require("../storePurchase/errors");
const { TELEMETRY_ONLY_KINDS } = require("../../constants/marketing");

const str = (v) => String(v ?? "").trim();

/* The kinds that withdraw permission. A manual do-not-contact in Mautic arrives
   as `email_unsubscribed` and is treated the same: whoever pressed it, the
   instruction is the same instruction. */
const SUPPRESSING_KINDS = new Set(["email_unsubscribed", "email_bounced"]);

/**
 * Resolve the canonical GRAV person for an observation.
 *
 * ── THE ORDER, AND WHY THERE IS NO THIRD STEP ─────────────────────────────
 *   1. the company-scoped Mautic external mapping — a link GRAV itself made
 *   2. an exact company-scoped canonical identity match on the address
 *   3. nothing
 *
 * There is deliberately no global lookup by email. An address is not an
 * identity: it gets reassigned to a successor, and a global match would attach
 * one company's webhook to another company's person. Both queries carry
 * `companyId`, so cross-company resolution is impossible by construction rather
 * than by a check somebody has to remember.
 */
async function resolveIdentity({ companyId, event } = {}) {
  if (!companyId) throw fail("TENANT_MEMBERSHIP_UNPROVEN", "Identity resolution needs a company.");

  const externalId = str(event.externalContactId);
  if (externalId) {
    const byMapping = await MarketingIdentity.findOne({
      companyId,
      externals: { $elemMatch: { system: str(event.source) || "mautic", externalId } },
    }).lean();
    if (byMapping) {
      return { identity: byMapping, gravPersonKey: byMapping.gravPersonKey, resolvedBy: "external_mapping" };
    }
  }

  const email = str(event.email).toLowerCase();
  if (email) {
    const byEmail = await MarketingIdentity.findOne({ companyId, email }).lean();
    if (byEmail) {
      return { identity: byEmail, gravPersonKey: byEmail.gravPersonKey, resolvedBy: "canonical_identity" };
    }
  }

  /* Unresolved is a legitimate outcome, not an error. The observation stands;
     Data Health lists it; nothing is invented to make it resolvable. */
  return { identity: null, gravPersonKey: "", resolvedBy: "unresolved" };
}

/* ── THE SUPPRESSION COMMAND KEY ─────────────────────────────────────────────
   Derived from the observation's own id, so a replay of the same webhook reuses
   it and the consent service — which is idempotent on exactly this key — appends
   no second history entry. Hashed only to bound the length; the input is the
   thing that makes it deterministic. */
const suppressionCommandKey = (event) =>
  `mautic-suppress:${crypto.createHash("sha256")
    .update(`${str(event.source)}|${str(event.sourceEventId)}`).digest("hex").slice(0, 32)}`;

/**
 * Process one recorded observation.
 *
 * Resumable: called again for the same event, it repeats nothing that succeeded
 * and retries whatever did not.
 *
 * @returns {Promise<object>} the receipt
 */
async function processEvent({ companyId, event, now = new Date() } = {}) {
  if (!companyId) throw fail("TENANT_MEMBERSHIP_UNPROVEN", "Event processing needs a company.");
  if (!event?._id) throw fail("VALIDATION", "Event processing needs the recorded observation.");

  const key = { companyId, source: str(event.source) || "mautic", sourceEventId: str(event.sourceEventId) };

  /* The receipt is created on first sight and reused thereafter, so the two
     halves of a resumed run share one row. */
  let receipt = await MarketingEventReceipt.findOneAndUpdate(
    key,
    {
      $setOnInsert: {
        ...key, eventId: event._id, kind: event.kind, occurredAt: event.occurredAt, state: "RECORDED",
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  /* ── 2. IDENTITY ───────────────────────────────────────────────────────
     Re-resolved on every pass, because a person unresolvable last week may be
     resolvable now. It updates the RECEIPT; the observation is untouched. */
  const resolved = await resolveIdentity({ companyId, event });
  receipt.gravPersonKey = resolved.gravPersonKey;
  receipt.resolvedBy = resolved.resolvedBy;
  receipt.resolvedAt = now;

  /* ── 3. SUPPRESSION ────────────────────────────────────────────────────
     Only a withdrawal, and only a bounce that is not merely temporary. */
  const needsSuppression = SUPPRESSING_KINDS.has(event.kind)
    && !(event.kind === "email_bounced" && event.bounceClass === "soft");

  if (needsSuppression) {
    if (!resolved.gravPersonKey) {
      /* Nobody to suppress. The event stands and the receipt says the work is
         owed, so a later resolution can complete it. */
      receipt.suppression.state = "pending";
      receipt.suppression.error = "No canonical GRAV person to suppress.";
    } else {
      /* ── VERIFY FIRST, AND REPAIR IF IT DOES NOT HOLD ──────────────────
         A receipt reading "applied" is our own bookkeeping, and consent history
         is written before the canonical row — so a crash between the two leaves
         a receipt claiming success over a record that still says opted in.

         An earlier version only re-verified and, on finding the drift, marked
         the receipt failed. That reported the problem and left it: the person
         stayed reachable and nothing repaired them. Verification now decides
         whether to RE-ISSUE the command, and re-issuing is safe because it is
         idempotent on a key derived from this event — a replay appends no
         history and reconciles the canonical row from what history already
         holds. */
      const verdict = await consentService.resolveEffective({
        companyId, gravPersonKey: resolved.gravPersonKey, ...consentService.MARKETING_EMAIL,
      }).catch(() => null);

      const alreadySuppressed = verdict?.state === "suppressed";
      /* Already settled as superseded on an earlier pass, and the canonical row
         still shows the later decision. Re-issuing would be an attempt to undo
         somebody's opt-in. */
      const stillSuperseded = receipt.suppression?.state === "superseded"
        && verdict && verdict.state !== "suppressed";

      if (alreadySuppressed) {
        receipt.suppression.state = "applied";
        receipt.suppression.at = receipt.suppression.at || now;
        receipt.suppression.error = "";
      } else if (stillSuperseded) {
        receipt.suppression.error = "";
      } else {
        const commandKey = suppressionCommandKey(event);
        receipt.suppression.commandKey = commandKey;
        receipt.suppression.attempts += 1;
        try {
          const out = await consentService.suppress({
            companyId,
            gravPersonKey: resolved.gravPersonKey,
            ...consentService.MARKETING_EMAIL,
            reason: reasonFor(event),
            /* No actor: a bounce and an unsubscribe are observed, not
               performed. Inventing a person for them would be a false
               attribution in the one record whose whole value is attribution. */
            actor: null,
            commandKey,
          });

          /* ── A HISTORY ROW IS NOT PROOF THE PERSON IS SUPPRESSED ───────
             `applied` is written only when the command is genuinely reflected
             in the current revision, or has been superseded by a later
             legitimate entry. Otherwise the receipt stays failed and is
             retried. */
          const reflected = out?.applied === true || out?.reflected === true;
          const confirmed = await consentService.resolveEffective({
            companyId, gravPersonKey: resolved.gravPersonKey, ...consentService.MARKETING_EMAIL,
          }).catch(() => null);

          if (reflected && confirmed?.state === "suppressed") {
            receipt.suppression.state = "applied";
            receipt.suppression.at = now;
            receipt.suppression.error = "";
          } else if (out?.superseded) {
            /* ── SETTLED, NOT FAILED ────────────────────────────────────────
               The command is durably in history and a LATER valid revision has
               replaced it — the person opted back in after unsubscribing, which
               is a legitimate sequence and not a fault. Marking this failed made
               it retry for ever and, worse, invited a repair that would have
               overwritten the newer decision.

               So it is settled, the newer state is recorded beside it as
               evidence, and — critically — the person is NOT described as
               currently suppressed. */
            receipt.suppression.state = "superseded";
            receipt.suppression.at = now;
            receipt.suppression.error = "";
            receipt.suppression.supersededByState = str(out.currentState);
            receipt.suppression.supersededByRevision = out.supersededBy?.revision || null;
          } else {
            receipt.suppression.state = "failed";
            receipt.suppression.error =
              "Consent history holds this command but the canonical consent record does not yet reflect it.";
          }
        } catch (err) {
          /* Visible and retryable. Emphatically not swallowed: acknowledging
             the webhook while losing the suppression is how somebody keeps
             receiving mail they asked to stop. */
          receipt.suppression.state = "failed";
          receipt.suppression.error = str(err?.message).slice(0, 400);
        }
      }
    }
  }

  /* ── 4. ACTIVITY ───────────────────────────────────────────────────────
     After suppression, and for a suppressing event, only once suppression has
     actually settled.

     ── WHY THE GATE, NOT JUST THE ORDERING ──────────────────────────────
     The order was already right and it was not enough. When the consent write
     failed, processing carried on and wrote "Marketing: unsubscribed from
     marketing email" onto the Sales timeline — while canonical consent still
     said opted in and the next campaign would still have sent to them. A
     salesperson reading that row would have believed a thing the system was
     about to contradict, and the timeline is exactly where such a claim is
     taken at face value.

     So a suppressing event projects nothing until its suppression is applied or
     settled as superseded. Pending and failed leave the Activity untouched, and
     recovery does suppression first and then writes exactly one row. */
  const suppressionSettled = !needsSuppression
    || receipt.suppression?.state === "applied"
    || receipt.suppression?.state === "superseded";

  let activityOutcome = null;
  if (receipt.activity?.state !== "projected") {
    if (!suppressionSettled) {
      /* Deliberately left at whatever it was — usually untouched — rather than
         marked pending or failed. Nothing has been attempted, and saying
         otherwise would put an Activity problem in front of somebody whose
         actual problem is a consent write. */
      receipt.activity.state = receipt.activity.state || "";
    } else if (TELEMETRY_ONLY_KINDS.has(event.kind) || !activityProjection.isProjectable(event)) {
      receipt.activity.state = "not_applicable";
    } else {
      receipt.activity.attempts += 1;
      try {
        activityOutcome = await activityProjection.project({
          companyId, event, identity: resolved.identity, now,
        });
        if (activityOutcome.projected || activityOutcome.duplicate) {
          receipt.activity.state = "projected";
          receipt.activity.at = now;
          receipt.activity.activityId = activityOutcome.activityId;
          receipt.activity.salesRecordType = str(activityOutcome.salesRecordType);
          receipt.activity.salesRecordId = activityOutcome.salesRecordId || null;
          receipt.activity.error = "";
        } else if (activityOutcome.reason === "NO_LINKED_SALES_RECORD") {
          /* Pending, not failed. Nothing is wrong; there is simply nobody in
             Sales to attach it to, and inventing one is the prohibition. */
          receipt.activity.state = "pending";
          receipt.activity.error = "No canonical Sales record is linked to this person.";
        } else {
          receipt.activity.state = "not_applicable";
        }
      } catch (err) {
        receipt.activity.state = "failed";
        receipt.activity.error = str(err?.message).slice(0, 400);
      }
    }
  }

  receipt.state = deriveState(receipt, event);
  receipt.ignoredReason = ignoredReasonFor(receipt, event);
  await receipt.save();
  return receipt.toObject();
}

/**
 * The one word that answers "is anything still owed on this event".
 *
 * ── THE ORDER REPORTS THE CAUSE, NOT THE SYMPTOM ──────────────────────────
 * Failures first, because they need somebody. Then IDENTITY_UNRESOLVED, and
 * that position is deliberate: an unresolved person makes the Activity
 * unprojectable, so reporting ACTIVITY_PENDING would send an operator to look
 * at a projection problem that is really an identity problem. Then genuinely
 * outstanding work, then the states that mean everything owed is done.
 *
 * The headline never contradicts the sub-states beside it: a receipt reading
 * ACTIVITY_PENDING with `suppression.state === "applied"` is saying both
 * things, and the suppression is the one that already happened.
 */
function deriveState(receipt, event) {
  if (receipt.suppression?.state === "failed") return "SUPPRESSION_FAILED";
  if (receipt.activity?.state === "failed") return "ACTIVITY_FAILED";
  if (!receipt.gravPersonKey) return "IDENTITY_UNRESOLVED";
  if (receipt.suppression?.state === "pending") return "SUPPRESSION_PENDING";
  if (receipt.activity?.state === "pending") return "ACTIVITY_PENDING";
  if (receipt.suppression?.state === "applied") return "SUPPRESSION_APPLIED";
  /* Settled, and NOT a claim that the person is suppressed now. */
  if (receipt.suppression?.state === "superseded") return "SUPPRESSION_SUPERSEDED";
  if (receipt.activity?.state === "projected") return "ACTIVITY_PROJECTED";
  if (TELEMETRY_ONLY_KINDS.has(event.kind)) return "IGNORED";
  if (receipt.activity?.state === "not_applicable") return "ACTIVITY_NOT_APPLICABLE";
  return "RECORDED";
}

function ignoredReasonFor(receipt, event) {
  if (receipt.state !== "IGNORED") return "";
  if (TELEMETRY_ONLY_KINDS.has(event.kind)) return "TELEMETRY_ONLY";
  if (event.kind === "email_resubscribed") return "RESUBSCRIBE_NEEDS_REVIEW";
  if (event.kind === "email_bounced" && event.bounceClass === "soft") return "SOFT_BOUNCE";
  return "";
}

const reasonFor = (event) => {
  if (event.kind === "email_unsubscribed") {
    return `Unsubscribed via Mautic (${str(event.previousStatus) || "contactable"} → ${str(event.newStatus) || "unsubscribed"}).`;
  }
  const cls = str(event.bounceClass) || "unknown";
  return cls === "hard"
    ? "Hard bounce reported by the mail provider."
    /* Said plainly. A row that claims a confirmed hard bounce it never had is a
       row somebody will later act on as though it were confirmed. */
    : "Bounced for a reason that could not be classified — suppressed pending review, NOT a confirmed hard bounce.";
};

/**
 * Resume every receipt that still owes work.
 *
 * The recovery path for a suppression or projection that failed, and for a
 * person who has since become resolvable. Company-scoped, bounded, and it
 * repeats nothing that already succeeded.
 */
async function resumeUnfinished({ companyId, limit = 50, now = new Date() } = {}) {
  if (!companyId) throw fail("TENANT_MEMBERSHIP_UNPROVEN", "Resuming needs a company.");
  const { MarketingIntentEvent } = require("../../models/CMS_Models/Marketing/MarketingEvent");

  const pending = await MarketingEventReceipt.find({
    companyId, state: { $in: MarketingEventReceipt.UNFINISHED_STATES },
  }).sort({ occurredAt: 1 }).limit(Math.min(limit, 200)).lean();

  const summary = { considered: pending.length, resolved: 0, stillPending: 0, integrity: [] };
  for (const r of pending) {
    /* ── THE COMPLETE EXPECTED IDENTITY, NOT JUST THE ID ─────────────────
       `findById` alone trusts the receipt's pointer. A receipt is mutable, and
       a corrupted or stale one holding another company's event id would have
       had company A's recovery read, process, suppress and project against
       company B's observation — a cross-tenant write reached through a field
       nobody validates.

       Every part the receipt claims to know is asserted: the id, the company,
       the source system and the source event id. A row that does not match all
       four is not this company's event, and is reported rather than acted on. */
    const event = await MarketingIntentEvent.findOne({
      _id: r.eventId,
      companyId,
      source: r.source,
      ...(str(r.sourceEventId) ? { sourceEventId: r.sourceEventId } : {}),
    }).lean();

    if (!event) {
      /* Left unfinished on purpose, and named. Silently skipping it would make
         a receipt that points at nothing indistinguishable from one that is
         merely waiting. */
      summary.stillPending += 1;
      summary.integrity.push({
        sourceEventId: r.sourceEventId,
        reason: "The receipt points at no observation belonging to this company.",
      });
      continue;
    }

    const out = await processEvent({ companyId, event, now });
    if (MarketingEventReceipt.UNFINISHED_STATES.includes(out.state)) summary.stillPending += 1;
    else summary.resolved += 1;
  }
  return summary;
}

/* The largest number of orphans a single count will look at. Bounded because
   the scan is a left join across the ledger, and an unbounded one on a busy
   company is a query nobody wants running behind a dashboard read. */
const ORPHAN_COUNT_CAP = 500;

/* ── LEDGER EVENTS WITH NO RECEIPT ──────────────────────────────────────────
   The ledger row is written first and the receipt second, so a crash between
   them leaves an observation nothing is tracking. `resumeUnfinished` scans
   receipts, so such an event was invisible to it — recorded, never processed,
   and never reported.

   This finds them by asking the ledger, not the receipts. Bounded and
   company-scoped: another company's orphan is neither read nor repaired. */
async function findEventsMissingReceipts({ companyId, limit = 100 } = {}) {
  if (!companyId) throw fail("TENANT_MEMBERSHIP_UNPROVEN", "Orphan recovery needs a company.");
  const { MarketingIntentEvent } = require("../../models/CMS_Models/Marketing/MarketingEvent");

  /* The ceiling is one above the count cap so the "+1 probe" that distinguishes
     exactly-500 from more-than-500 is not itself clamped away. */
  const capped = Math.max(1, Math.min(Number(limit) || 100, ORPHAN_COUNT_CAP + 1));
  /* A left join in the database rather than two lists in memory: the ledger is
     the larger collection and pulling all of it back to diff would not stay
     bounded. */
  return MarketingIntentEvent.aggregate([
    { $match: { companyId } },
    { $sort: { receivedAt: 1 } },
    {
      $lookup: {
        from: "marketing_event_receipts",
        let: { src: "$source", sid: "$sourceEventId", co: "$companyId" },
        pipeline: [{
          $match: {
            $expr: {
              $and: [
                { $eq: ["$companyId", "$$co"] },
                { $eq: ["$source", "$$src"] },
                { $eq: ["$sourceEventId", "$$sid"] },
              ],
            },
          },
        }, { $limit: 1 }, { $project: { _id: 1 } }],
        as: "receipt",
      },
    },
    { $match: { receipt: { $size: 0 } } },
    { $limit: capped },
    { $project: { receipt: 0 } },
  ]);
}

/**
 * How many observations this company holds that nothing is tracking.
 *
 * ── THE CAP IS REPORTED, NOT HIDDEN ─────────────────────────────────────────
 * This returned a bare number capped at 500, so 500 and fifty thousand were
 * indistinguishable — an operator reading "500" would have had no way to know
 * whether that was the answer or the ceiling, and a backlog that stopped
 * growing on screen would have looked like a backlog that stopped growing.
 *
 * The query asks for one MORE than the cap, which is what makes "exactly 500"
 * and "at least 500" different answers rather than the same one.
 *
 * @returns {Promise<{count:number, capped:boolean}>} `capped` means "at least".
 */
async function countEventsMissingReceipts({ companyId, cap = ORPHAN_COUNT_CAP } = {}) {
  const limit = Math.max(1, Number(cap) || ORPHAN_COUNT_CAP);
  const rows = await findEventsMissingReceipts({ companyId, limit: limit + 1 });
  const capped = rows.length > limit;
  return { count: capped ? limit : rows.length, capped };
}

/**
 * Create and process the receipts for orphaned observations.
 *
 * Concurrency-safe because `processEvent` upserts the receipt on the unique
 * (company, source, sourceEventId) key — two recoveries racing produce one
 * receipt, and the loser reads the winner's.
 */
async function recoverMissingReceipts({ companyId, limit = 50, now = new Date() } = {}) {
  const orphans = await findEventsMissingReceipts({ companyId, limit });
  const summary = { found: orphans.length, recovered: 0, failed: 0 };
  for (const event of orphans) {
    try {
      await processEvent({ companyId, event, now });
      summary.recovered += 1;
    } catch (err) {
      summary.failed += 1;
      console.error("[marketing] orphan recovery failed:", str(err?.message));
    }
  }
  return summary;
}

module.exports = {
  processEvent, resolveIdentity, resumeUnfinished,
  findEventsMissingReceipts, countEventsMissingReceipts, recoverMissingReceipts,
  ORPHAN_COUNT_CAP,
  suppressionCommandKey, deriveState, SUPPRESSING_KINDS,
};
