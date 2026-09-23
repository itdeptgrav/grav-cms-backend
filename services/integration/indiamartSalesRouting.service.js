// services/integration/indiamartSalesRouting.service.js
//
// SENDING GENUINE INDIAMART BUYER ENQUIRIES TO SALES — THROUGH THE EXISTING
// MARKETING HANDOVER, ONCE EACH, WITHOUT A MARKETER'S APPROVAL.
//
// ── THE ONLY PATH TO SALES ─────────────────────────────────────────────────
//   1. the buyer's request is recorded in the Marketing intent ledger, once
//      (source "indiamart", keyed on GRAV's own enquiry reference) — the same
//      way Google lead processing records a lead-form submission;
//   2. `prospectHandover.submit` builds the handover from that evidence and
//      writes it with its outbox announcement;
//   3. `marketingProspectDelivery.deliverPending` carries it to Sales' own
//      receiver, which is the one Sales writer: it deduplicates against
//      existing Leads, Contacts and Accounts and creates at most one draft,
//      unassigned Lead per handover, for Sales to review.
// This file writes no Sales record itself and requires no Sales module. It is
// in services/integration because, like marketingProspectDelivery, it is the
// one place that legitimately knows both applications.
//
// ── WHAT IS ROUTED, AND WHAT IS NOT ────────────────────────────────────────
// Only `buyer_enquiry` (IndiaMART W direct enquiries, P calls, WA WhatsApp).
// Buy-Leads and catalog views are never routed automatically. Anything
// incomplete, unreadable, too old or refused is HELD with a reason a person
// can act on — never dropped, never guessed.
//
// ── ONCE, WHATEVER HAPPENS ─────────────────────────────────────────────────
//   · one routing row per enquiry (unique), claimed atomically per attempt;
//   · the intent event is unique per enquiry;
//   · the handover's correlation id is derived from the enquiry, and submit
//     returns the existing handover for it;
//   · the outbox is unique per correlation id; Sales' receipt is unique per
//     handover, and Sales links a known phone or email instead of creating.
// A crash at any step is resumed by the next claim, and every step it repeats
// answers "already done".
//
// ── NEVER INFERRED ─────────────────────────────────────────────────────────
// Marketing permission travels as `unknown`: IndiaMART never asks for it, and
// an enquiry about a product is not consent to marketing.
"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");

const { MarketingSourceEnquiry } = require("../../models/CMS_Models/Marketing/MarketingSourceEnquiry");
const { MarketingSourceEnquiryRouting } = require("../../models/CMS_Models/Marketing/MarketingSourceEnquiryRouting");
const { MarketingIntentEvent, MarketingOutboxEvent } = require("../../models/CMS_Models/Marketing/MarketingEvent");
const producer = require("../marketing/prospectHandover.service");
const delivery = require("./marketingProspectDelivery.service");
const { fail } = require("../storePurchase/errors");
const { MARKETING_EVENT_KINDS } = require("../../constants/marketing");
const I = require("../../constants/marketingIndiamart");

const str = (v) => String(v ?? "").trim();
const R = I.ROUTING;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const idempotencyKeyFor = (companyId, submissionRef) => `indiamart-enquiry:${String(companyId)}:${submissionRef}`;
const eventKeyFor = (submissionRef) => `indiamart-enquiry:${submissionRef}`;
const contactKeyFor = (submissionRef) => `indiamart:${submissionRef}`;

/* ═══════════════════════════════════════════════════════════════════════════
   THE DECISION — PURE
   ═══════════════════════════════════════════════════════════════════════════ */

function splitName(full) {
  const parts = str(full).split(/\s+/).filter(Boolean);
  return { firstName: parts[0] || "", lastName: parts.slice(1).join(" ") };
}

/**
 * What to do with one enquiry.
 *
 * @returns {{ action: "route", input: object } | { action: "hold"|"not_routed", reason: string }}
 */
function decide(enquiry, { nowMs, override = {}, timeConfirmation = null } = {}) {
  const c = enquiry.contact || {};
  const x = enquiry.context || {};

  if (enquiry.kind === "purchased_lead" || enquiry.kind === "catalog_view") {
    return { action: "not_routed", reason: "kind_not_routed" };
  }
  if (enquiry.kind !== "buyer_enquiry" && !(enquiry.kind === "unclassified" && override.confirmBuyerEnquiry)) {
    return { action: "hold", reason: "unclassified_type" };
  }
  /* ── THE ENQUIRY TIME: READ, OR CONFIRMED BY A NAMED PERSON, NEVER GUESSED ─
     A confirmation stands in only for a time that could not be read or was
     impossible; it never overrides a readable, possible one. */
  const receivedMs = new Date(enquiry.receivedAt).getTime();
  const plausible = (ms) => ms <= receivedMs + R.FUTURE_SLACK_MS && ms >= receivedMs - R.PLAUSIBLE_PAST_MS;
  let submittedAt = null;
  let provenance = "";
  if (enquiry.submittedAt && plausible(new Date(enquiry.submittedAt).getTime())) {
    submittedAt = new Date(enquiry.submittedAt);
    provenance = "source";
  } else if (timeConfirmation?.submittedAt) {
    submittedAt = new Date(timeConfirmation.submittedAt);
    provenance = "reviewer_confirmed";
  } else {
    return { action: "hold", reason: enquiry.submittedAt ? "submitted_time_implausible" : "submitted_time_unknown" };
  }
  /* Old is a different fact from invalid: a valid time more than 30 days ago. */
  if (nowMs - submittedAt.getTime() > R.MAX_AGE_MS) return { action: "hold", reason: "too_old" };

  const email = [str(c.email), str(c.emailAlt)].find(Boolean) || "";
  const phone = [str(c.phone), str(c.phoneAlt), str(c.landline), str(c.landlineAlt)].find(Boolean) || "";
  if (!email && !phone) return { action: "hold", reason: "contact_missing" };
  let workEmail = email.toLowerCase();
  if (workEmail && !EMAIL_SHAPE.test(workEmail)) {
    if (!(phone && override.usePhoneOnly)) return { action: "hold", reason: "contact_invalid" };
    workEmail = "";
  }

  const name = str(override.contactName) || str(c.fullName);
  if (!name) return { action: "hold", reason: "name_missing" };
  const companyName = str(c.companyName) || str(override.companyName);
  if (!companyName) return { action: "hold", reason: "company_name_missing" };

  const type = I.QUERY_TYPES[str(enquiry.sourceType)] || null;
  const channel = type ? type.label : "Enquiry";
  const { firstName, lastName } = splitName(name);
  const topics = [str(x.productName), str(x.categoryName)].filter(Boolean);

  return {
    action: "route",
    email: workEmail,
    submittedAt,
    provenance,
    input: {
      company: { name: companyName, country: str(c.country) },
      person: { firstName, lastName, workEmail, workPhone: phone },
      externalContactId: contactKeyFor(enquiry.submissionRef),
      marketing: {
        sourceSystem: I.SOURCE,
        source: `${R.SOURCE_LABEL} — ${channel}`,
        campaignName: R.CAMPAIGN_NAME,
        assetName: str(x.productName),
        firstSeenAt: submittedAt,
      },
      /* Never inferred: IndiaMART does not ask. */
      permission: { emailConsent: "unknown", phoneConsent: "unknown" },
      topicsOfInterest: topics,
      provenance: [{
        provider: I.SOURCE,
        /* GRAV's own reference; IndiaMART's id stays in the enquiry record. */
        lookupReference: enquiry.submissionRef,
        retrievedAt: enquiry.receivedAt,
        fields: Object.keys(c).filter((k) => k !== "nameIsPlaceholder" && str(c[k])),
      }],
      sourceEnquiry: {
        source: I.SOURCE,
        sourceRef: enquiry.submissionRef,
        channel,
        kind: enquiry.kind,
        submittedAt,
        submittedAtText: str(enquiry.submittedAtText),
        submittedAtProvenance: provenance,
        submittedAtConfirmedBy: provenance === "reviewer_confirmed" ? str(timeConfirmation.by?.name) : "",
        submittedAtConfirmedAt: provenance === "reviewer_confirmed" ? timeConfirmation.at : null,
        submittedAtConfirmationNote: provenance === "reviewer_confirmed" ? str(timeConfirmation.note) : "",
        receivedAt: enquiry.receivedAt,
        subject: str(x.subject),
        productName: str(x.productName),
        categoryName: str(x.categoryName),
        message: str(x.message),
        callDurationSeconds: x.callDurationSeconds ?? null,
      },
    },
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   THE ROUTING LEDGER
   ═══════════════════════════════════════════════════════════════════════════ */

/** Enquiries with no routing row yet get one, oldest first. Idempotent. */
async function discover(companyId, limit) {
  const fresh = await MarketingSourceEnquiry.aggregate([
    { $match: { companyId, source: I.SOURCE } },
    { $sort: { receivedAt: 1, _id: 1 } },
    {
      $lookup: {
        from: MarketingSourceEnquiryRouting.collection.name,
        let: { e: "$_id", co: "$companyId" },
        pipeline: [
          { $match: { $expr: { $and: [{ $eq: ["$companyId", "$$co"] }, { $eq: ["$enquiryId", "$$e"] }] } } },
          { $limit: 1 },
          { $project: { _id: 1 } },
        ],
        as: "r",
      },
    },
    { $match: { r: { $size: 0 } } },
    { $limit: limit },
    { $project: { _id: 1, submissionRef: 1, kind: 1 } },
  ]);
  if (!fresh.length) return 0;
  try {
    const out = await MarketingSourceEnquiryRouting.insertMany(
      fresh.map((e) => ({
        companyId, enquiryId: e._id, submissionRef: e.submissionRef, source: I.SOURCE, kind: e.kind, state: "pending",
      })),
      { ordered: false },
    );
    return out.length;
  } catch (err) {
    /* Another worker created some of them. Theirs stand. */
    if (err?.code === 11000 || err?.writeErrors) return Number(err?.insertedDocs?.length || 0);
    throw err;
  }
}

/** Take the next due row, atomically. */
async function claimNext(companyId, nowMs, only = null) {
  const now = new Date(nowMs);
  const token = crypto.randomBytes(12).toString("hex");
  const row = await MarketingSourceEnquiryRouting.findOneAndUpdate(
    {
      companyId,
      ...(only ? { _id: only } : {}),
      state: { $in: ["pending", "retrying"] },
      $and: [
        { $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }] },
        { $or: [{ claimUntil: null }, { claimUntil: { $lte: now } }] },
      ],
    },
    { $set: { claimToken: token, claimUntil: new Date(nowMs + R.CLAIM_MS) } },
    { new: true, sort: { createdAt: 1, _id: 1 }, lean: true },
  );
  return row ? { row, token } : null;
}

const release = { claimToken: "", claimUntil: null };

async function settle(row, token, set, extra = {}) {
  return MarketingSourceEnquiryRouting.updateOne(
    { _id: row._id, claimToken: token },
    { $set: { ...release, ...set }, ...extra },
  );
}

/* Record the buyer's request in the Marketing intent ledger, once. The same
   shape Google lead processing writes for a lead-form submission. */
async function recordRequest({ companyId, enquiry, email, now, submittedAt, provenance }) {
  try {
    await MarketingIntentEvent.create({
      companyId,
      source: R.EVENT_SOURCE,
      sourceEventId: eventKeyFor(enquiry.submissionRef),
      kind: R.EVENT_KIND,
      externalContactId: contactKeyFor(enquiry.submissionRef),
      email: email || "",
      occurredAt: new Date(submittedAt),
      receivedAt: now,
      campaignId: "",
      campaignName: R.CAMPAIGN_NAME,
      assetName: str(enquiry.context?.productName).slice(0, 300),
      topics: [str(enquiry.context?.productName), str(enquiry.context?.categoryName)].filter(Boolean),
      evidence: {
        /* Says whether the time was the source's or a reviewer's, and keeps
           the source's own text beside it. */
        providerRecordType: provenance === "reviewer_confirmed" ? "indiamart_enquiry_time_confirmed" : "indiamart_enquiry",
        providerEventType: str(enquiry.sourceType).slice(0, 80),
        providerTimestamp: str(enquiry.submittedAtText).slice(0, 40),
      },
    });
  } catch (err) {
    /* Recorded by an earlier attempt: the evidence is the same. */
    if (err?.code !== 11000) throw err;
  }
}

function backoff(attempts) {
  return Math.min(R.RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), R.RETRY_MAX_MS);
}

/* Deliver one handover's announcement to Sales. Never throws. */
async function deliverOne({ companyId, row, nowMs }) {
  if (!row.correlationId) return false;
  const out = await delivery.deliverPending({ companyId, correlationId: row.correlationId, limit: 1 });
  const outbox = await MarketingOutboxEvent.findOne({
    companyId, correlationId: row.correlationId, kind: MARKETING_EVENT_KINDS.HANDOVER_SUBMITTED,
  }).select("status").lean();
  const delivered = outbox?.status === "DELIVERED";
  await MarketingSourceEnquiryRouting.updateOne(
    { _id: row._id },
    delivered
      ? { $set: { deliveredAt: new Date(nowMs) } }
      : { $inc: { deliveryAttempts: out.attempted ? 1 : 0 } },
  );
  return delivered;
}

/**
 * Route one claimed row. Always settles the claim.
 *
 * @returns {Promise<string>} the resulting state
 */
async function processClaimed({ companyId, row, token, nowMs, actor }) {
  const now = new Date(nowMs);
  const enquiry = await MarketingSourceEnquiry
    .findOne({ companyId, _id: row.enquiryId })
    .select("submissionRef kind sourceType submittedAt submittedAtText receivedAt contact context")
    .lean();
  if (!enquiry) {
    await settle(row, token, { state: "held_for_review", reason: "routing_failed", reasonDetail: "The enquiry record could not be read.", decidedAt: now });
    return "held_for_review";
  }

  const decision = decide(enquiry, {
    nowMs, override: row.review?.override || {}, timeConfirmation: row.timeConfirmation || null,
  });
  if (decision.action !== "route") {
    const state = decision.action === "not_routed" ? "not_routed" : "held_for_review";
    await settle(row, token, { state, reason: decision.reason, reasonDetail: "", decidedAt: now, nextAttemptAt: null });
    return state;
  }

  try {
    await recordRequest({
      companyId, enquiry, email: decision.email, now, submittedAt: decision.submittedAt, provenance: decision.provenance,
    });
    const result = await producer.submit({
      companyId,
      input: decision.input,
      actor: actor || { name: "IndiaMART routing (automatic)" },
      idempotencyKey: idempotencyKeyFor(companyId, enquiry.submissionRef),
      now,
    });
    const h = result.handover;
    const common = {
      handoverRef: str(h.handoverRef),
      handoverId: h._id,
      correlationId: str(h.correlationId),
      decidedAt: now,
      nextAttemptAt: null,
      lastErrorCode: "",
    };
    if (result.blocked) {
      await settle(row, token, {
        ...common, state: "held_for_review", reason: "handover_blocked", reasonDetail: str(result.reason).slice(0, 500),
      });
      return "held_for_review";
    }
    await settle(row, token, { ...common, state: "sent_to_sales", reason: "", reasonDetail: "", sentAt: row.sentAt || now });
    await deliverOne({ companyId, row: { ...row, ...common }, nowMs });
    return "sent_to_sales";
  } catch (err) {
    /* A rule the handover applies is not a transient failure. */
    if (err?.code === "VALIDATION" && Number(err?.status) === 400) {
      await settle(row, token, {
        state: "held_for_review", reason: "handover_refused", decidedAt: now,
        reasonDetail: `${str(err.message)}${err.details?.field ? ` (${err.details.field})` : ""}`.slice(0, 500),
      });
      return "held_for_review";
    }
    const attempts = (row.attempts || 0) + 1;
    const code = str(err?.code || err?.name || "error").slice(0, 60);
    console.error(`[indiamart-routing] routing attempt failed: ${code}`);
    if (attempts >= R.MAX_ATTEMPTS) {
      await settle(row, token, {
        state: "held_for_review", reason: "routing_failed", attempts, lastErrorCode: code, decidedAt: now, nextAttemptAt: null,
      });
      return "held_for_review";
    }
    await settle(row, token, {
      state: "retrying", attempts, lastErrorCode: code, nextAttemptAt: new Date(nowMs + backoff(attempts)),
    });
    return "retrying";
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   ONE COMPANY'S ROUTING PASS
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Discover, route and deliver, bounded. Safe to run from any number of
 * processes at once.
 */
async function routeCompany({ companyId, now = Date.now, limit = I.SCHEDULE.ROUTE_PER_CYCLE } = {}) {
  if (!companyId) throw fail("TENANT_MEMBERSHIP_UNPROVEN", "Routing needs a company.");
  const company = new mongoose.Types.ObjectId(String(companyId));
  const summary = { discovered: 0, routed: 0, sentToSales: 0, held: 0, notRouted: 0, retrying: 0, delivered: 0 };

  summary.discovered = await discover(company, limit);

  for (let i = 0; i < limit; i += 1) {
    const taken = await claimNext(company, now());
    if (!taken) break;
    summary.routed += 1;
    const state = await processClaimed({ companyId: company, row: taken.row, token: taken.token, nowMs: now() });
    if (state === "sent_to_sales") summary.sentToSales += 1;
    else if (state === "held_for_review") summary.held += 1;
    else if (state === "not_routed") summary.notRouted += 1;
    else if (state === "retrying") summary.retrying += 1;
  }

  /* Handovers that reached the outbox but not Sales: retried every cycle. */
  const undelivered = await MarketingSourceEnquiryRouting
    .find({ companyId: company, state: "sent_to_sales", deliveredAt: null })
    .sort({ sentAt: 1 }).limit(I.SCHEDULE.DELIVER_PER_CYCLE).lean();
  for (const row of undelivered) {
    if (await deliverOne({ companyId: company, row, nowMs: now() })) summary.delivered += 1;
  }
  return summary;
}

/* ═══════════════════════════════════════════════════════════════════════════
   EXPLICIT REVIEW
   ═══════════════════════════════════════════════════════════════════════════ */

const holdFor = (code) => I.HOLD_REASONS.find((r) => r.code === code) || null;
const NOT_FOUND = () => fail("NOT_FOUND", "That enquiry is not one GRAV can show you.");
const actorOf = (user = {}) => ({ id: str(user.id || user._id), name: str(user.name) });

async function heldRow(company, submissionRef) {
  const row = await MarketingSourceEnquiryRouting.findOne({ companyId: company, submissionRef: str(submissionRef) }).lean();
  if (!row) throw NOT_FOUND();
  if (row.state !== "held_for_review") {
    throw fail("INVALID_TRANSITION", "Only an enquiry held for review can be released or dismissed.", { state: row.state });
  }
  return row;
}

/**
 * A reviewer sends a held enquiry on, supplying only what its reason allows.
 * It is routed at once, through the same path.
 */
async function releaseHeld({ companyId, submissionRef, user, body = {}, now = Date.now }) {
  const company = new mongoose.Types.ObjectId(String(companyId));
  const row = await heldRow(company, submissionRef);
  const hold = holdFor(row.reason);
  if (!hold?.release) {
    throw fail("INVALID_TRANSITION",
      `"${hold?.label || row.reason}" cannot be released: it has to be dismissed, or fixed at the source.`,
      { reason: row.reason });
  }
  const releaseField = hold.release === "confirmSubmittedAt" ? "submittedAt" : hold.release;
  const allowed = ["note", releaseField];
  const unknown = Object.keys(body).filter((k) => !allowed.includes(k));
  if (unknown.length) {
    throw fail("VALIDATION", `This hold accepts only: ${allowed.join(", ")}.`, { unknown });
  }
  const override = { ...(row.review?.override || {}) };
  let timeConfirmation = null;
  if (hold.release === "confirmSubmittedAt") {
    timeConfirmation = await confirmedTime({ company, row, body, user, now });
  }
  if (hold.release === "companyName" || hold.release === "contactName") {
    const v = str(body[hold.release]);
    if (!v || v.length > (hold.release === "companyName" ? 300 : 200)) {
      throw fail("VALIDATION", `${hold.release} is required to release this enquiry.`, { field: hold.release });
    }
    override[hold.release] = v;
  } else if (hold.release === "confirmBuyerEnquiry" || hold.release === "usePhoneOnly") {
    if (body[hold.release] !== true) {
      throw fail("VALIDATION", `${hold.release} must be true to release this enquiry.`, { field: hold.release });
    }
    override[hold.release] = true;
  }
  const at = new Date(now());
  const moved = await MarketingSourceEnquiryRouting.findOneAndUpdate(
    { _id: row._id, state: "held_for_review" },
    {
      $set: {
        state: "pending", reason: "", reasonDetail: "", nextAttemptAt: null, attempts: 0,
        review: {
          action: "release", at, by: actorOf(user), fromReason: row.reason, note: str(body.note).slice(0, 500), override,
        },
        ...(timeConfirmation ? { timeConfirmation } : {}),
      },
    },
    { new: true, lean: true },
  );
  if (!moved) throw fail("INVALID_TRANSITION", "This enquiry changed while you were reviewing it. Reload and try again.");
  const taken = await claimNext(company, now(), moved._id);
  if (taken) {
    await processClaimed({
      companyId: company, row: taken.row, token: taken.token, nowMs: now(),
      actor: { ...actorOf(user), name: str(user?.name) || "Marketing reviewer" },
    });
  }
  return MarketingSourceEnquiryRouting.findById(moved._id).lean();
}

/* A reviewer's confirmed enquiry time. It must carry its time zone, say how it
   was confirmed, and be possible: not after GRAV received the enquiry and not
   older than IndiaMART keeps enquiries. The source's text is not touched. */
async function confirmedTime({ company, row, body, user, now }) {
  const raw = str(body.submittedAt);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(raw)) {
    throw fail("VALIDATION",
      "submittedAt must be the enquiry time as shown in IndiaMART, with its time zone (for example 2026-09-20T10:15:00+05:30).",
      { field: "submittedAt" });
  }
  const note = str(body.note);
  if (!note || note.length > 500) {
    throw fail("VALIDATION", "Say how you confirmed the time (for example, checked in IndiaMART's Lead Manager).", { field: "note" });
  }
  const enquiry = await MarketingSourceEnquiry.findOne({ companyId: company, _id: row.enquiryId }).select("receivedAt").lean();
  if (!enquiry) throw NOT_FOUND();
  const ms = Date.parse(raw);
  const receivedMs = new Date(enquiry.receivedAt).getTime();
  if (!Number.isFinite(ms) || ms > receivedMs + R.FUTURE_SLACK_MS || ms < receivedMs - R.PLAUSIBLE_PAST_MS) {
    throw fail("VALIDATION",
      "That time is not possible for this enquiry: it is after GRAV received it, or older than IndiaMART keeps enquiries.",
      { field: "submittedAt", receivedAt: new Date(receivedMs).toISOString() });
  }
  return {
    submittedAt: new Date(ms), fromReason: row.reason, at: new Date(now()), by: actorOf(user), note: note.slice(0, 500),
  };
}

async function dismissHeld({ companyId, submissionRef, user, body = {}, now = Date.now }) {
  const company = new mongoose.Types.ObjectId(String(companyId));
  const row = await heldRow(company, submissionRef);
  const unknown = Object.keys(body).filter((k) => k !== "note");
  if (unknown.length) throw fail("VALIDATION", "Dismissing accepts only: note.", { unknown });
  const note = str(body.note);
  if (!note || note.length > 500) {
    throw fail("VALIDATION", "Say why this enquiry is kept out of Sales (up to 500 characters).", { field: "note" });
  }
  const done = await MarketingSourceEnquiryRouting.findOneAndUpdate(
    { _id: row._id, state: "held_for_review" },
    {
      $set: {
        state: "dismissed",
        review: { action: "dismiss", at: new Date(now()), by: actorOf(user), fromReason: row.reason, note, override: row.review?.override || {} },
      },
    },
    { new: true, lean: true },
  );
  if (!done) throw fail("INVALID_TRANSITION", "This enquiry changed while you were reviewing it. Reload and try again.");
  return done;
}

module.exports = {
  routeCompany,
  releaseHeld,
  dismissHeld,
  __internals: { decide, discover, claimNext, processClaimed, idempotencyKeyFor, eventKeyFor },
};
