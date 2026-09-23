// services/marketing/mauticEventIntake.service.js
//
// EVERY MAUTIC OBSERVATION, RECORDED EXACTLY ONCE.
//
// ── WHY THE LEDGER IS THE WHOLE MECHANISM ──────────────────────────────────
// Mautic retries. So does every webhook sender worth using — it is how they
// survive our downtime, and the price of that is that we will be told the same
// thing twice. An intake that treats the second telling as new is an intake
// that eventually creates two Prospects for one person, and that is the
// failure a salesperson experiences as "Marketing keeps sending me the same
// lead".
//
// So the guarantee is not "we try not to double-process": it is a unique index
// on (source, sourceEventId), and a duplicate-key error IS the answer. Nothing
// downstream has to be careful, because nothing downstream ever sees a second
// copy.
//
// ── AN EVENT IS AN OBSERVATION, NOT A COMMAND ──────────────────────────────
// Receiving an event creates no Prospect, sends nothing and moves no
// lifecycle. It records that something happened. A handover is a separate,
// deliberate act with its own checks — see prospectHandover.service.js.
//
// ── WHAT IS DELIBERATELY NOT VALIDATED AWAY ────────────────────────────────
// An event of a kind this application does not model is stored and
// acknowledged rather than refused. Refusing it would make Mautic retry it for
// ever, and dropping it silently would lose evidence we may want later. It is
// simply not counted as intent.
"use strict";

const { MarketingIntentEvent } = require("../../models/CMS_Models/Marketing/MarketingEvent");
const MarketingEventReceipt = require("../../models/CMS_Models/Marketing/MarketingEventReceipt");
const { INTENT_EVENT_KIND_CODES } = require("../../constants/marketing");
const { fail } = require("../storePurchase/errors");

const str = (v) => String(v ?? "").trim();
const lower = (v) => str(v).toLowerCase();

/* ── SAFE LOGGING ───────────────────────────────────────────────────────────
   A work email in a log line is personal data in a file with a wider audience
   than the record it came from. Enough of it survives to correlate an incident
   and not enough to identify anybody. */
const maskEmail = (email) => {
  const v = lower(email);
  const at = v.indexOf("@");
  if (at <= 0) return v ? "***" : "";
  return `${v[0]}***@${v.slice(at + 1)}`;
};

/* ── SIGNATURE VERIFICATION LIVES IN ONE PLACE ──────────────────────────────
   It used to live here, and it was wrong: it expected a hex digest in
   `x-mautic-signature`, and real Mautic 7.x sends BASE64 in a header named
   `Webhook-Signature` (verified against `mautic/core-lib`
   bundles/WebhookBundle/Http/Client.php). An endpoint written to the
   GitHub/Meta convention rejects every genuine delivery, and the symptom —
   401s that look like a wrong secret — sends people to rotate a credential
   that was never the problem.

   The rule now has exactly one implementation, in ./mauticWebhookContract.js,
   which accepts both encodings and all three header spellings. This export is
   kept so existing callers keep working, and it delegates rather than holding
   a second copy: two implementations of one security rule are two chances for
   only one of them to be fixed. */
const { verifySignature } = require("./mauticWebhookContract");

/**
 * Record one marketing observation.
 *
 * @param {object} args.companyId  resolved by the caller, never taken from the payload
 * @param {object} args.event      the normalised event
 * @returns {Promise<{recorded:boolean, duplicate:boolean, eventId:any}>}
 */
async function recordEvent({ companyId, event = {} } = {}) {
  if (!companyId) {
    throw fail("TENANT_MEMBERSHIP_UNPROVEN", "A marketing event cannot be recorded without a company.");
  }

  const sourceEventId = str(event.sourceEventId);
  if (!sourceEventId) {
    /* Refused, not stored with a generated id. An id we invented cannot
       deduplicate anything, and storing the event anyway would make the
       ledger's guarantee quietly false for exactly the events most likely to
       be replayed. */
    throw fail("VALIDATION", "A marketing event needs the source system's own event id.", {
      field: "sourceEventId", terminal: true,
    });
  }

  const kind = str(event.kind);
  if (!INTENT_EVENT_KIND_CODES.includes(kind)) {
    throw fail("VALIDATION", `"${kind}" is not a marketing event this application records.`, {
      field: "kind", terminal: true, accepted: INTENT_EVENT_KIND_CODES,
    });
  }

  const occurredAt = event.occurredAt ? new Date(event.occurredAt) : null;
  if (!occurredAt || Number.isNaN(occurredAt.getTime())) {
    throw fail("VALIDATION", "A marketing event needs the time it happened.", { field: "occurredAt", terminal: true });
  }

  const doc = {
    companyId,
    source: str(event.source) || "mautic",
    sourceEventId,
    kind,
    externalContactId: str(event.externalContactId),
    email: lower(event.email),
    campaignId: str(event.campaignId),
    campaignName: str(event.campaignName),
    assetName: str(event.assetName),
    topics: (Array.isArray(event.topics) ? event.topics : []).map(str).filter(Boolean),
    occurredAt,
    receivedAt: new Date(),
    gravPersonKey: str(event.gravPersonKey),
    bounceClass: str(event.bounceClass),
    previousStatus: str(event.previousStatus),
    newStatus: str(event.newStatus),
    /* Bounded and redacted by the schema. The provider's whole item is
       deliberately not carried — see the model for what that cost. */
    evidence: event.evidence || {},
  };

  /* Read first for the ordinary repeat, and let the unique index settle a
     race. Neither alone is enough: a check can be passed by two requests at
     once, and an index alone would make the common case — Mautic resending —
     an exception path that depends on a collection index existing. */
  const seen = await MarketingIntentEvent
    .findOne({ companyId, source: doc.source, sourceEventId }).select("_id").lean();
  if (seen) return { recorded: false, duplicate: true, eventId: seen._id };

  try {
    const created = await MarketingIntentEvent.create(doc);
    return { recorded: true, duplicate: false, eventId: created._id };
  } catch (err) {
    if (err?.code === 11000) {
      /* THE ORDINARY CASE, NOT AN ERROR. Mautic told us again. */
      const existing = await MarketingIntentEvent
        .findOne({ companyId, source: doc.source, sourceEventId }).select("_id").lean();
      if (existing) return { recorded: false, duplicate: true, eventId: existing._id };
      /* A duplicate-key error with nothing to point at is not a replay — it is
         a collision on some other constraint, or a row that vanished between
         the two statements. Reporting `duplicate: true, eventId: null` would
         acknowledge an event nothing holds. */
      throw Object.assign(new Error("A duplicate ledger key resolved to no stored event."), {
        code: "MARKETING_INTAKE_UNAVAILABLE",
      });
    }
    /* Infrastructure. Logged without the person, and rethrown so the caller
       answers 5xx and Mautic retries — swallowing it would acknowledge an event
       that was never stored. */
    console.error(`[marketing] event intake failed for ${maskEmail(doc.email)}:`, str(err?.message));
    throw Object.assign(err, { code: err?.code || "MARKETING_INTAKE_UNAVAILABLE" });
  }
}

/**
 * The recent evidence for one person — what a handover is built from.
 *
 * Scoped by company, matched on the identity the caller holds. Never a global
 * lookup by email: an email address is not a tenant.
 */
async function recentEventsFor({ companyId, email, externalContactId, sinceDays = 90, limit = 50 } = {}) {
  if (!companyId) {
    throw fail("TENANT_MEMBERSHIP_UNPROVEN", "Marketing events cannot be read without a company.");
  }
  const identity = [];
  if (lower(email)) identity.push({ email: lower(email) });
  if (str(externalContactId)) identity.push({ externalContactId: str(externalContactId) });
  if (!identity.length) return [];

  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);
  return MarketingIntentEvent
    .find({ companyId, $or: identity, occurredAt: { $gte: since } })
    .sort({ occurredAt: -1 })
    .limit(limit)
    .lean();
}

/**
 * Note which events a handover was built from.
 *
 * ── IT WRITES TO THE RECEIPT, NOT THE OBSERVATION ─────────────────────────
 * This used to `$set` `usedInHandoverRef` onto the recorded events — workflow
 * state, edited into evidence, in a collection whose own header called itself
 * immutable. The ledger now refuses every update, so that write would throw;
 * the link belongs on the mutable half of the pair and that is where it goes.
 *
 * Best effort: failing to note the link must not undo a handover that has
 * already been recorded.
 */
async function markUsedInHandover({ companyId, sourceEventIds = [], handoverRef }) {
  const ids = sourceEventIds.map(str).filter(Boolean);
  if (!ids.length || !str(handoverRef)) return 0;
  try {
    const r = await MarketingEventReceipt.updateMany(
      { companyId, sourceEventId: { $in: ids } },
      { $set: { usedInHandoverRef: str(handoverRef) } },
    );
    return r.modifiedCount || 0;
  } catch (err) {
    console.error("[marketing] could not note the handover link:", str(err?.message));
    return 0;
  }
}

module.exports = { verifySignature, recordEvent, recentEventsFor, markUsedInHandover, maskEmail };
