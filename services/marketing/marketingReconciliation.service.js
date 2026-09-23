// services/marketing/marketingReconciliation.service.js
//
// WHAT IS WRONG WITH THIS COMPANY'S MARKETING SYNCHRONISATION, AND NOTHING ELSE.
//
// ── READ-ONLY, AND THAT IS A DESIGN DECISION ───────────────────────────────
// "Reconciliation must detect missing mappings, drift and unprocessed events
// WITHOUT editing customer data automatically" (product plan §10). So nothing
// in this file writes. Not a repair, not a retry, not a counter, not a
// "while we are here" fix.
//
// The reason is not purity. A reconciliation that mutates cannot be run by
// somebody who is merely trying to understand a problem: every look changes the
// thing being looked at, two operators investigating in parallel fight each
// other, and a report can never be reproduced. Acting is
// `marketingDelivery.runDueRetries`, which has to be asked for by name.
//
// ── CONFLICTS RESOLVE TOWARD SUPPRESSION ───────────────────────────────────
// A person can be in more than one category at once — a suppressed person may
// also have a failed delivery scheduled from before they were suppressed. They
// are reported as SUPPRESSED, and they are NOT in the retry-due list, because
// the only thing a retry could achieve for them is the send their suppression
// forbids. Categorisation is therefore ordered, refusing first, and
// `categorise()` below is the one place that order is expressed.
//
// ── AND IT NEVER SYNCHRONISES ANYBODY ──────────────────────────────────────
// There is no Mautic client in this file and no import that could reach one.
// A reconciliation that could enrol somebody is a reconciliation that will,
// the first time a loop is written slightly wrong.
"use strict";

const DeliveryState = require("../../models/CMS_Models/Marketing/MarketingDeliveryState");
const MarketingIdentity = require("../../models/CMS_Models/Marketing/MarketingIdentity");
const { MarketingConsent } = require("../../models/CMS_Models/Marketing/MarketingConsent");
const { fail } = require("../storePurchase/errors");
const { MARKETING_EMAIL, DELIVERY_RETRY } = require("../../constants/marketing");
const deliveryService = require("./marketingDelivery.service");

const str = (v) => String(v ?? "").trim();

/* ── THE CATEGORIES ─────────────────────────────────────────────────────────
   One person lands in exactly one, and the order below is the precedence. It is
   written as a list rather than a switch so that "suppression wins" is visible
   as a position rather than buried in a branch. */
const CATEGORIES = Object.freeze([
  "SUPPRESSED",              // the channel is unusable; nothing may be sent
  "CONSENT_INELIGIBLE",      // no permission — unknown, withdrawn, or never asked
  "BLOCKED_TERMINAL",        // a failure a person must look at
  "IN_FLIGHT_STALE",         // an attempt that started and never finished
  "RETRY_DUE",               // a transient failure whose backoff has elapsed
  "RETRY_WAITING",           // a transient failure still in backoff
  "IN_FLIGHT",               // an attempt is running right now
  "MISSING_MAPPING",         // eligible, never successfully projected
  "SYNCHRONIZED",            // linked and up to date
]);

/** Categories that describe a problem somebody should act on. */
const ACTIONABLE = Object.freeze([
  "SUPPRESSED", "CONSENT_INELIGIBLE", "BLOCKED_TERMINAL",
  "RETRY_DUE", "RETRY_WAITING", "IN_FLIGHT_STALE", "MISSING_MAPPING",
]);
/* IN_FLIGHT is deliberately NOT actionable: an attempt that started a moment ago
   needs nobody's attention. It becomes IN_FLIGHT_STALE, which is, once it has
   outlived a lease. */

/**
 * Which category one person is in.
 *
 * Pure, and exported, so the precedence can be tested directly rather than
 * inferred from a query's output.
 *
 * @param {object} args.consent   the person's marketing-email consent row, or null
 * @param {object} args.delivery  their delivery-state row, or null
 * @param {object} args.suppressedOnChannel  any suppressed row on the email
 *   channel, whatever its purpose — suppression is a fact about the address
 */
function categorise({ consent, delivery, suppressedOnChannel, now = new Date() } = {}) {
  /* 1. SUPPRESSION FIRST, whatever else is true. Asked across purposes because
        a hard bounce recorded against transactional mail still means the address
        is unusable for marketing. */
  if (suppressedOnChannel) {
    return { category: "SUPPRESSED", reasonCode: "CONSENT_SUPPRESSED" };
  }

  /* 2. NO PERMISSION. Before any delivery consideration: retrying a projection
        for somebody who has not agreed is not a recovery, it is the thing
        consent forbids. */
  if (!consent || consent.state !== "opted_in") {
    return {
      category: "CONSENT_INELIGIBLE",
      reasonCode: !consent ? "CONSENT_MISSING"
        : (consent.state === "opted_out" ? "CONSENT_WITHDRAWN" : "CONSENT_UNKNOWN"),
    };
  }

  /* From here the person IS eligible, so everything below is about delivery. */
  if (!delivery || delivery.health === "NEVER_ATTEMPTED") {
    return { category: "MISSING_MAPPING", reasonCode: "DELIVERY_NEVER_ATTEMPTED" };
  }

  /* ── AN OPEN ATTEMPT, BEFORE ANYTHING ELSE IS CONCLUDED ────────────────
     Checked here rather than only under SYNCHRONIZED, which is where it used to
     be. A first attempt that crashed leaves IN_FLIGHT with no prior success, and
     the old order read that as MISSING_MAPPING — "never projected" — which is
     the one thing it definitely is not. It is reported as stale once it has
     outlived a lease, and simply as running before that. */
  if (delivery.health === "IN_FLIGHT") {
    return isStaleInFlight(delivery, now)
      ? { category: "IN_FLIGHT_STALE", reasonCode: "DELIVERY_IN_FLIGHT_STALE" }
      : { category: "IN_FLIGHT", reasonCode: "DELIVERY_IN_FLIGHT" };
  }

  if (delivery.health === "BLOCKED_CONSENT") {
    /* The stored state disagrees with the consent record — consent was granted
       after the block. Reported as needing a projection, not as blocked: the
       record is stale, and saying "blocked" would send an operator to fix
       permission that is already fixed. */
    return { category: "MISSING_MAPPING", reasonCode: "DELIVERY_NEVER_ATTEMPTED" };
  }

  if (delivery.health === "BLOCKED_TERMINAL") {
    return { category: "BLOCKED_TERMINAL", reasonCode: delivery.activeError?.reasonCode || "PROJECTION_INVALID" };
  }

  if (delivery.health === "RETRY_SCHEDULED") {
    const due = delivery.nextAttemptAt && delivery.nextAttemptAt <= now;
    return {
      category: due ? "RETRY_DUE" : "RETRY_WAITING",
      reasonCode: delivery.activeError?.reasonCode || "MAUTIC_UNREACHABLE",
    };
  }

  if (delivery.health === "SYNCHRONIZED") {
    /* A stale in-flight marker on an otherwise synchronized row means a later
       attempt started and never finished. The previous success stands, and the
       unfinished attempt is still worth surfacing. */
    if (isStaleInFlight(delivery, now)) {
      /* Its OWN reason, not DELIVERY_OK. A row whose last attempt never finished
         is not healthy, and reporting it as "synchronized with Mautic" told an
         operator the opposite of the truth. The earlier success still stands and
         `lastSuccessfulSyncAt` still carries it. */
      return { category: "IN_FLIGHT_STALE", reasonCode: "DELIVERY_IN_FLIGHT_STALE" };
    }
    if (!str(delivery.mauticContactId)) {
      /* Synchronized with no contact id is drift: the success was recorded but
         the link is not readable. A person must reconcile it; GRAV must not
         guess. */
      return { category: "BLOCKED_TERMINAL", reasonCode: "PROJECTION_INVALID" };
    }
    return { category: "SYNCHRONIZED", reasonCode: "DELIVERY_OK" };
  }

  return { category: "BLOCKED_TERMINAL", reasonCode: "PROJECTION_INVALID" };
}

/** An attempt that opened and never closed, older than a claim's lifetime. */
const isStaleInFlight = (row, now) =>
  Boolean(row?.inFlightSince) && (now - row.inFlightSince) > DELIVERY_RETRY.CLAIM_TTL_MS;

/**
 * Reconcile one company. READ-ONLY.
 *
 * Walks the people this company has a marketing identity for, joins their
 * consent and delivery state, and groups them. The identity collection is the
 * spine because it is the set of people Marketing knows: a delivery row without
 * one is unreachable, and a consent row without one belongs to nobody.
 *
 * @returns {Promise<{counts:object, totals:object, people:Array, generatedAt:Date}>}
 */
async function reconcile({ companyId, limit = 200, cursor = null, category = null, now = new Date() } = {}) {
  if (!companyId) {
    throw fail("TENANT_MEMBERSHIP_UNPROVEN", "Reconciliation needs a company.");
  }
  if (category && !CATEGORIES.includes(category)) {
    throw fail("VALIDATION", `"${category}" is not a reconciliation category.`, { accepted: CATEGORIES });
  }

  const pageSize = Math.max(1, Math.min(Number(limit) || 200, 500));

  /* Company-scoped on every one of the three reads. Not "scoped on the first and
     joined from there": a join that carries the company only implicitly is a
     join somebody will later widen. */
  const identityFilter = { companyId };
  if (cursor) identityFilter._id = { $gt: cursor };

  const identities = await MarketingIdentity.find(identityFilter)
    .select("gravPersonKey email externals")
    .sort({ _id: 1 })
    .limit(pageSize + 1)
    .lean();

  const hasMore = identities.length > pageSize;
  const page = hasMore ? identities.slice(0, pageSize) : identities;
  const keys = page.map((i) => i.gravPersonKey);

  const [consents, deliveries, suppressions] = await Promise.all([
    MarketingConsent.find({
      companyId, gravPersonKey: { $in: keys }, ...MARKETING_EMAIL,
    }).lean(),
    DeliveryState.find({ companyId, gravPersonKey: { $in: keys } }).lean(),
    /* Across purposes, on the email channel. The one read that deliberately
       ignores purpose, and only ever to refuse. */
    MarketingConsent.find({
      companyId, gravPersonKey: { $in: keys }, channel: MARKETING_EMAIL.channel, state: "suppressed",
    }).lean(),
  ]);

  const consentBy = new Map(consents.map((c) => [c.gravPersonKey, c]));
  const deliveryBy = new Map(deliveries.map((d) => [d.gravPersonKey, d]));
  const suppressedBy = new Map(suppressions.map((c) => [c.gravPersonKey, c]));

  const counts = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
  const reasonCounts = {};
  const people = [];

  for (const identity of page) {
    const key = identity.gravPersonKey;
    const verdict = categorise({
      consent: consentBy.get(key) || null,
      delivery: deliveryBy.get(key) || null,
      suppressedOnChannel: suppressedBy.get(key) || null,
      now,
    });
    counts[verdict.category] += 1;
    reasonCounts[verdict.reasonCode] = (reasonCounts[verdict.reasonCode] || 0) + 1;

    if (category && verdict.category !== category) continue;
    people.push(describe(identity, deliveryBy.get(key), verdict, now));
  }

  return {
    generatedAt: now,
    counts,
    reasonCounts,
    totals: {
      people: page.length,
      actionable: ACTIONABLE.reduce((n, c) => n + counts[c], 0),
      synchronized: counts.SYNCHRONIZED,
    },
    page: { size: page.length, hasMore, nextCursor: hasMore ? String(page[page.length - 1]._id) : null },
    people,
  };
}

/* ── WHAT AN OPERATOR IS SHOWN ABOUT ONE PERSON ─────────────────────────────
   Enough to find them and act; not enough to be a contact export. The email is
   MASKED — an operator needs to tell two rows apart and to recognise a domain,
   which a mask gives them, and does not need a list of addresses, which is what
   an unmasked report is. Consent evidence is omitted entirely: capture source
   and notice version are a compliance record, not an operations one. */
function describe(identity, delivery, verdict, now) {
  return {
    gravPersonKey: identity.gravPersonKey,
    emailMasked: maskEmail(identity.email),
    emailDomain: domainOf(identity.email),
    category: verdict.category,
    reasonCode: verdict.reasonCode,
    effectiveHealth: deliveryService.effectiveHealth(delivery, now),
    /* The engine's contact reference under a GRAV name. The stored column keeps
       the product's name because it is a stored column; the wire does not. */
    engineContactRef: str(delivery?.mauticContactId) || null,
    attempts: delivery?.attempts || 0,
    retryCount: delivery?.retryCount || 0,
    lastAttemptAt: delivery?.lastAttemptAt || null,
    lastSuccessfulSyncAt: delivery?.lastSuccessfulSyncAt || null,
    nextAttemptAt: delivery?.nextAttemptAt || null,
    /* The operator sentence and the code behind it. NOT the provider's body,
       which was never stored. */
    lastErrorMessage: str(delivery?.activeError?.message) || null,
    lastErrorSourceCode: str(delivery?.activeError?.sourceCode) || null,
  };
}

const maskEmail = (email) => {
  const v = str(email).toLowerCase();
  const at = v.indexOf("@");
  if (at <= 0) return v ? "***" : "";
  return `${v[0]}***@${v.slice(at + 1)}`;
};

const domainOf = (email) => {
  const v = str(email).toLowerCase();
  const at = v.indexOf("@");
  return at > 0 ? v.slice(at + 1) : "";
};

/**
 * The retry backlog, as counts. Cheap enough to call on every Data Health read,
 * because it is three aggregations and not a walk.
 *
 * `dueNow` and `waiting` are computed from the clock at read time for the same
 * reason the stored health does not split them.
 */
async function backlog({ companyId, now = new Date() } = {}) {
  if (!companyId) throw fail("TENANT_MEMBERSHIP_UNPROVEN", "The retry backlog needs a company.");

  const [scheduled, dueNow, terminal, consentBlocked, lastSuccess] = await Promise.all([
    DeliveryState.countDocuments({ companyId, health: "RETRY_SCHEDULED" }),
    DeliveryState.countDocuments({ companyId, health: "RETRY_SCHEDULED", nextAttemptAt: { $lte: now } }),
    DeliveryState.countDocuments({ companyId, health: "BLOCKED_TERMINAL" }),
    DeliveryState.countDocuments({ companyId, health: "BLOCKED_CONSENT" }),
    DeliveryState.findOne({ companyId, lastSuccessfulSyncAt: { $ne: null } })
      .sort({ lastSuccessfulSyncAt: -1 }).select("lastSuccessfulSyncAt").lean(),
  ]);

  return {
    scheduled,
    dueNow,
    waiting: scheduled - dueNow,
    blockedTerminal: terminal,
    blockedConsent: consentBlocked,
    /* null when nothing has ever synchronized. NOT a zero or an epoch: "never"
       and "at the beginning of time" are different facts, and the product plan
       is explicit that an unavailable or absent reading is never reported as a
       number. */
    lastSuccessfulSyncAt: lastSuccess?.lastSuccessfulSyncAt || null,
    maxAttempts: DELIVERY_RETRY.MAX_ATTEMPTS,
  };
}

module.exports = {
  reconcile, backlog, categorise, maskEmail,
  CATEGORIES, ACTIONABLE,
};
