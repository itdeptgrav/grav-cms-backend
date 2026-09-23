// services/marketing/prospectHandover.service.js
//
// MARKETING SUBMITS A HANDOVER. IT DOES NOT CREATE A PROSPECT.
//
// ── THE ONE SENTENCE THIS FILE EXISTS TO KEEP TRUE ─────────────────────────
// Nothing here imports a Sales model, a Sales service or a Sales route. Not
// `Lead`, not `leadReview`, not `leadQualification`. The Prospect is created by
// Sales' own receiver, from an event this file writes to an outbox. That is
// what makes "Marketing cannot create an Active Lead" a fact about the code
// rather than a promise in a document — there is no reachable path from here
// to the two services that write a Lead's lifecycle.
//
// ── IDEMPOTENCY IS A KEY, NOT A CHECK ──────────────────────────────────────
// Two things could produce a duplicate Prospect, and each is closed with an
// index rather than a lookup:
//
//   · the same Mautic event handed over twice → the caller supplies an
//     idempotency key derived from the source events, and the handover's
//     correlation id is unique per outbox kind;
//   · the same handover DELIVERED twice → the Sales intake ledger is unique on
//     (companyId, handoverRef), and the Lead carries a matching partial unique
//     index.
//
// A check ("does one already exist?") would close neither, because two
// requests can both pass a check before either writes.
//
// ── A REFUSED HANDOVER IS STILL RECORDED ───────────────────────────────────
// A person who is suppressed, or who has not shown enough interest, produces a
// BLOCKED handover with the reason on it — not a silent discard. Marketing has
// to be able to answer "why did that campaign produce nothing", and a
// discarded refusal makes that unanswerable.
"use strict";

const crypto = require("crypto");

const Handover = require("../../models/CMS_Models/Marketing/ProspectHandover");
const {
  MarketingAuditEvent, MarketingOutboxEvent,
} = require("../../models/CMS_Models/Marketing/MarketingEvent");
const MarketingIdentity = require("../../models/CMS_Models/Marketing/MarketingIdentity");
/* A shared atomic-counter primitive, not a Sales concept. services/leadRef.js
   imports the same `Counter` for the same reason: one counter collection in
   the codebase, not two competing implementations. The keys are disjoint
   ("marketingHandover:<year>" here), so the sequences cannot collide. */
const { Counter } = require("../salesJourneyRef");

const contract = require("./handoverContract");
const assessment = require("./handoverAssessment");
const events = require("./mauticEventIntake.service");
const { fail } = require("../storePurchase/errors");
const { MARKETING_EVENT_KINDS } = require("../../constants/marketing");

const str = (v) => String(v ?? "").trim();

/* ── THE REFERENCE ──────────────────────────────────────────────────────────
   Atomic per year, exactly like LEAD-YYYY-NNNN and JOURNEY refs. Not a random
   id: this is the number a marketer and a salesperson quote to each other. */
async function nextHandoverRef(year = new Date().getFullYear()) {
  const doc = await Counter.findOneAndUpdate(
    { key: `marketingHandover:${year}` },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).lean();
  return `MHO-${year}-${String(doc.seq).padStart(4, "0")}`;
}

/** Test seam, mirroring services/leadRef.js's. */
async function _resetSequence(year = new Date().getFullYear()) {
  await Counter.deleteOne({ key: `marketingHandover:${year}` });
}

/* ── THE CORRELATION IDENTITY ───────────────────────────────────────────────
   Derived from the company, the person and the evidence — so the SAME
   submission retried produces the same id and the unique outbox index refuses
   the second announcement, while a genuinely new submission (new evidence)
   produces a different one and is allowed through.

   An explicit `idempotencyKey` from the caller wins when supplied: a client
   that knows two requests are the same attempt can say so, and that is more
   reliable than anything derived. */
function correlationFor({ companyId, pkg, idempotencyKey }) {
  const explicit = str(idempotencyKey);
  const basis = explicit || [
    String(companyId),
    pkg.matchKeys.normalizedEmail || pkg.matchKeys.normalizedPhone,
    pkg.matchKeys.normalizedCompanyName,
    [...pkg.sourceEventIds].sort().join(","),
  ].join("|");
  return crypto.createHash("sha256").update(basis).digest("hex").slice(0, 32);
}

/**
 * Build a handover package from recorded evidence plus whatever the caller
 * knows, WITHOUT submitting it. Exposed so a marketer can see exactly what
 * Sales would be sent, and what the assessment says, before deciding.
 *
 * The evidence comes from the ledger, never from the request: a caller could
 * otherwise assert an engagement that never happened, and the whole point of
 * the evidence is that somebody else observed it.
 */
async function preparePackage({ companyId, input = {}, now = new Date() } = {}) {
  if (!companyId) {
    throw fail("TENANT_MEMBERSHIP_UNPROVEN", "A handover cannot be prepared without a company.");
  }

  const ledgerRows = await events.recentEventsFor({
    companyId,
    email: input.person?.workEmail,
    externalContactId: input.externalContactId,
  });

  /* Activities are the LEDGER's, mapped. An activity the caller supplied that
     the ledger has no row for is dropped, not merged: Marketing vouches for
     what Mautic recorded, and a hand-typed engagement is not that. */
  const activities = ledgerRows.map((r) => ({
    kind: r.kind,
    occurredAt: r.occurredAt,
    campaignName: r.campaignName,
    assetName: r.assetName,
    detail: "",
    sourceEventId: r.sourceEventId,
  }));

  const topics = [...new Set([
    ...(Array.isArray(input.topicsOfInterest) ? input.topicsOfInterest : []),
    ...ledgerRows.flatMap((r) => r.topics || []),
  ].map(str).filter(Boolean))];

  const newest = ledgerRows[0] || null;
  const pkg = contract.normalizePackage({
    ...input,
    activities,
    topicsOfInterest: topics,
    externalContactId: input.externalContactId || newest?.externalContactId || "",
    marketing: {
      ...(input.marketing || {}),
      campaignId: input.marketing?.campaignId || newest?.campaignId || "",
      campaignName: input.marketing?.campaignName || newest?.campaignName || "",
      assetName: input.marketing?.assetName || newest?.assetName || "",
      firstSeenAt: input.marketing?.firstSeenAt
        || (ledgerRows.length ? ledgerRows[ledgerRows.length - 1].occurredAt : null),
    },
  });

  const permission = contract.checkPermission(pkg);
  const threshold = contract.checkThreshold(pkg, now);
  return { pkg, permission, threshold, assessment: assessment.assess(pkg, now) };
}

/**
 * Submit a handover to Sales.
 *
 * Writes the handover, its audit row and — when it passed every gate — the
 * outbox announcement. Delivery is a separate step (services/integration/
 * marketingProspectDelivery.service.js), so a Sales receiver that is
 * temporarily unable to apply the event does not fail the marketer's request.
 *
 * @returns {Promise<{handover, blocked:boolean, reason:string, duplicate:boolean}>}
 */
async function submit({ companyId, input = {}, actor = {}, idempotencyKey = "", now = new Date() } = {}) {
  const { pkg, permission, threshold, assessment: assessed } =
    await preparePackage({ companyId, input, now });

  const correlationId = correlationFor({ companyId, pkg, idempotencyKey });

  /* ── ALREADY SUBMITTED? ────────────────────────────────────────────────
     Read before write for a clean, useful answer; the unique outbox index
     below is what actually enforces it if two requests race. */
  const existing = await Handover.findOne({ companyId, correlationId }).lean();
  if (existing) {
    return {
      handover: existing,
      blocked: existing.state === "BLOCKED",
      reason: existing.blockedReason || "",
      duplicate: true,
    };
  }

  const blocked = !permission.allowed ? permission.reason
    : (!threshold.met ? threshold.reason : "");

  const handoverRef = await nextHandoverRef(now.getFullYear());
  const doc = {
    companyId,
    handoverRef,
    state: blocked ? "BLOCKED" : "AWAITING_REVIEW",
    ...pkg,
    assessment: assessed,
    submittedAt: blocked ? null : now,
    submittedBy: actor?.id || actor?.name ? actor : undefined,
    blockedReason: blocked,
    correlationId,
  };

  let handover;
  try {
    handover = await Handover.create(doc);
  } catch (err) {
    if (err?.code === 11000) {
      const raced = await Handover.findOne({ companyId, correlationId }).lean();
      if (raced) return { handover: raced, blocked: raced.state === "BLOCKED", reason: raced.blockedReason || "", duplicate: true };
    }
    throw err;
  }

  await MarketingAuditEvent.create({
    companyId,
    handoverRef,
    handoverId: handover._id,
    action: blocked ? "handover.blocked" : "handover.submitted",
    actor,
    at: now,
    reason: blocked,
    previousState: "",
    resultingState: handover.state,
    correlationId,
    details: {
      campaignName: pkg.marketing.campaignName,
      accountFit: assessed.accountFit,
      intent: assessed.intent,
      thresholdBasis: threshold.basis,
      evidenceCount: pkg.activities.length,
    },
  });

  if (!blocked) {
    /* The announcement, beside the record it announces. A committed handover
       with no announcement waiting is a handover Sales will never see. */
    try {
      await MarketingOutboxEvent.create({
        companyId,
        kind: MARKETING_EVENT_KINDS.HANDOVER_SUBMITTED,
        payload: { handoverId: handover._id, handoverRef },
        occurredAt: now,
        actor,
        correlationId,
      });
    } catch (err) {
      /* A duplicate announcement is the guarantee working, not a failure. */
      if (err?.code !== 11000) throw err;
    }
    await events.markUsedInHandover({ companyId, sourceEventIds: pkg.sourceEventIds, handoverRef });
    await linkIdentity({ companyId, pkg });
  }

  return { handover: handover.toObject(), blocked: Boolean(blocked), reason: blocked, duplicate: false };
}

/* ── THE IDENTITY MAPPING ───────────────────────────────────────────────────
   Keyed on an opaque GRAV key, never on the email address (product plan §10).
   The key is derived once from the identity that existed at first sight and
   then never recomputed, so a person who changes employer keeps their row
   rather than acquiring a second one. */
async function linkIdentity({ companyId, pkg }) {
  const identityBasis = pkg.matchKeys.normalizedEmail
    || pkg.matchKeys.normalizedPhone
    || `${pkg.matchKeys.normalizedCompanyName}:${pkg.person.firstName}`;
  if (!identityBasis) return null;

  const gravPersonKey = crypto.createHash("sha256")
    .update(`${companyId}|${identityBasis}`).digest("hex").slice(0, 24);

  const set = {
    email: pkg.matchKeys.normalizedEmail,
    normalizedPhone: pkg.matchKeys.normalizedPhone,
    companyDomain: pkg.matchKeys.companyDomain,
  };

  try {
    const row = await MarketingIdentity.findOneAndUpdate(
      { companyId, gravPersonKey },
      { $set: set, $setOnInsert: { companyId, gravPersonKey } },
      { upsert: true, new: true },
    );
    const externalId = pkg.matchKeys.externalContactId;
    if (externalId && !row.externals.some((e) => e.system === "mautic" && e.externalId === externalId)) {
      row.externals.push({ system: "mautic", externalId, proven: true, linkedAt: new Date() });
      await row.save();
    }
    for (const p of pkg.provenance || []) {
      if (!p.providerRecordId) continue;
      if (row.externals.some((e) => e.system === p.provider && e.externalId === p.providerRecordId)) continue;
      row.externals.push({ system: p.provider, externalId: p.providerRecordId, proven: false, linkedAt: new Date() });
    }
    if (row.isModified()) await row.save();
    return row;
  } catch (err) {
    /* An identity row is a convenience for later matching. Failing to write
       one must not fail a handover that has already been recorded. */
    console.error("[marketing] identity mapping failed:", str(err?.message));
    return null;
  }
}

/** Pending announcements, oldest by when Marketing ACTED. */
async function pendingOutboxEvents({ companyId = null, correlationId = "", limit = 50 } = {}) {
  const q = { status: "PENDING" };
  if (companyId) q.companyId = companyId;
  if (str(correlationId)) q.correlationId = str(correlationId);
  return MarketingOutboxEvent.find(q).sort({ occurredAt: 1, _id: 1 }).limit(limit).lean();
}

async function markOutboxDelivered(id) {
  await MarketingOutboxEvent.updateOne(
    { _id: id },
    { $set: { status: "DELIVERED", deliveredAt: new Date(), lastError: "" }, $inc: { attempts: 1 } },
  );
}

async function markOutboxAttemptFailed(id, err) {
  await MarketingOutboxEvent.updateOne(
    { _id: id },
    {
      $set: { lastAttemptAt: new Date(), lastError: str(err?.message).slice(0, 500) },
      $inc: { attempts: 1 },
    },
  );
}

/** The authoritative handover, read by reference. The Sales receiver calls
 *  this rather than reaching into the Marketing collection itself. */
async function readByRef(companyId, handoverRef) {
  return Handover.findOne({ companyId, handoverRef }).lean();
}

module.exports = {
  nextHandoverRef, _resetSequence,
  preparePackage, submit,
  pendingOutboxEvents, markOutboxDelivered, markOutboxAttemptFailed,
  readByRef, correlationFor,
};
