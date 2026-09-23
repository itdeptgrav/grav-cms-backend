// services/marketing/mauticContactSync.service.js
//
// ONE CONSENTED GRAV PERSON, PROJECTED INTO MAUTIC EXACTLY ONCE.
//
// ── THE IDENTITY RULE, WRITTEN DOWN ────────────────────────────────────────
// A person is matched in this order, and the order is the whole design:
//
//   1. THE MAPPING ROW. If `MarketingIdentity` already names a Mautic contact
//      id for this GRAV person, that contact IS the person. No search runs.
//      This is what survives a changed email address — the case that quietly
//      creates a second identity in every integration that skips it.
//   2. AN EXACT EMAIL MATCH, once. `where[0][col]=email&expr=eq`, never
//      `search=`. A fuzzy match is not an identity rule, and the cost of
//      getting it wrong is writing one person's details onto another's record.
//   3. CREATE.
//
// After 1, 2 or 3 the mapping row is written, so the next call takes path 1
// and never searches again.
//
// ── WHY THE EMAIL IS NOT THE KEY ───────────────────────────────────────────
// The product plan is explicit (§10): "Use an opaque GRAV person identifier as
// Mautic's external key. Never use an email address as the durable identity
// key." People change jobs; addresses get reassigned to their successor. An
// integration keyed on the address silently starts writing to somebody else,
// and nothing about that failure looks like a failure.
//
// ── THE PROJECTION IS AN ALLOWLIST ─────────────────────────────────────────
// Mautic receives the minimum a campaign needs and nothing else. It is not a
// second customer master (ADR-004), so no commercial field, no lifecycle
// state, no requirement and no internal note is sent. The allowlist is a
// constant here rather than a filter at the call site, so widening it is a
// visible edit to this file.
//
// ── CONSENT IS RESOLVED SERVER-SIDE, NOT ACCEPTED FROM THE CALLER ──────────
// This function used to take a `consent` argument and check it. That reads like
// an enforcement and is not one: any caller wanting a person in Mautic could
// have them by passing `{ emailConsent: "opted_in" }`, with no record, no
// evidence and nobody accountable. The check tested the REQUEST, and a request
// cannot be the authority on whether a person agreed to be marketed to.
//
// So the argument is gone. `services/marketing/marketingConsent.service.js`
// reads the canonical GRAV consent record for this company, this person, the
// email channel and the marketing purpose, and its answer is the only one that
// counts here. A caller that still passes `consent` is REFUSED — loudly, with a
// message saying where consent comes from — rather than having it ignored: an
// ignored parameter lets a caller believe they granted something, and that
// belief is the whole vulnerability this closes.
//
// "No record with unknown or opted-out email consent may be enrolled in a
// marketing email campaign." A projection is the step before enrolment, and it
// is refused for anybody not effectively opted in — deliberately stricter than
// the handover gate, which allows `unknown` because a handover is a
// person-to-person introduction rather than a marketing send.
//
// ── THE IDENTITY IS PERSISTED BEFORE THE FIRST REMOTE CALL ─────────────────
// It used to be written only after Mautic answered, on the reasonable-sounding
// ground that a mapping to a contact that may not exist is worse than none. The
// mapping still works that way. The IDENTITY does not, and the difference
// matters because `marketingReconciliation.service.js` walks identities: a
// person whose very first projection failed had a delivery-state row and no
// identity, so Data Health could not see them, the retry runner could not find
// them, and the failure this whole model exists to surface was invisible.
//
// So the base identity — the stable person key and the routing address — is
// written after validation and consent and BEFORE any remote call. The Mautic
// external mapping is still appended only once Mautic has genuinely returned or
// matched a contact, so nothing claims a link that does not exist.
//
// ── EVERY ATTEMPT IS RECORDED, INCLUDING THE ONES THAT NEVER REACH MAUTIC ──
// The attempt is opened in `marketingDelivery.service.js` BEFORE the remote call
// and resolved afterwards, so a failure that happens before Mautic returns a
// contact id — unreachable, credential refused, write rejected — still becomes a
// queryable row. There is deliberately no uninstrumented path: this function is
// the only way a person reaches Mautic, so wrapping it here is what makes the
// Data Health backlog complete rather than best-effort.
//
// A consent refusal is recorded too, and separately. It is not a fault and is
// never retried, because nothing GRAV does will change it.
"use strict";

const MarketingIdentity = require("../../models/CMS_Models/Marketing/MarketingIdentity");
const { fail } = require("../storePurchase/errors");
const { maskEmail } = require("./mauticClient");
const consentService = require("./marketingConsent.service");
const delivery = require("./marketingDelivery.service");

const str = (v) => String(v ?? "").trim();

/** The only fields GRAV sends to Mautic. Widening this is a design decision. */
const PROJECTION_FIELDS = Object.freeze([
  "email", "firstname", "lastname", "company", "phone", "website", "country", "position",
]);

/* A GRAV-owned custom field on the Mautic contact, carrying the opaque key so
   the mapping can be rebuilt from Mautic's side after a restore. Must exist in
   Mautic as a custom contact field with this alias — README.md's setup step. */
const EXTERNAL_KEY_FIELD = "grav_person_key";

/** Build the projection. Anything not on the allowlist is dropped silently —
 *  a caller cannot widen the contract by passing extra keys. */
function buildProjection(person = {}, gravPersonKey = "") {
  const out = {};
  const source = {
    email: str(person.workEmail || person.email).toLowerCase(),
    firstname: str(person.firstName),
    lastname: str(person.lastName),
    company: str(person.companyName || person.company),
    phone: str(person.workPhone || person.phone),
    website: str(person.website),
    country: str(person.country),
    position: str(person.jobTitle),
  };
  for (const key of PROJECTION_FIELDS) {
    if (source[key]) out[key] = source[key];
  }
  if (gravPersonKey) out[EXTERNAL_KEY_FIELD] = gravPersonKey;
  return out;
}

/**
 * Create or update the Mautic contact for one consented GRAV person, and
 * record the identity mapping.
 *
 * Idempotent: calling it twice with the same person produces one Mautic
 * contact and one mapping row, and the second call reports `created:false`.
 *
 * Takes NO consent argument. Eligibility comes from the canonical record, and
 * passing one is an error — see this file's header.
 *
 * @throws 403 MARKETING_CONSENT_INELIGIBLE when the person is not effectively
 *   opted in, with a stable `details.reasonCode`
 * @throws 400 MARKETING_CONSENT_CALLER_SUPPLIED when a caller passes consent
 * @returns {Promise<{contactId:string, created:boolean, matchedBy:string,
 *                    identity:object, consent:object}>}
 */
async function syncContact({
  client, companyId, gravPersonKey, person = {},
  /* INTERNAL. Minted by marketingDelivery.claimDue and passed by the retry
     runner so this attempt's settles are fenced to that lease. Never reaches
     here from an HTTP route — no route calls syncContact — and is deliberately
     not part of the documented parameter set. */
  __leaseToken = "",
  ...rest
} = {}) {
  if (!companyId) {
    throw fail("TENANT_MEMBERSHIP_UNPROVEN", "A Mautic projection needs a company.");
  }

  /* ── THE CALLER MAY NOT BRING ITS OWN PERMISSION ───────────────────────
     Checked FIRST, before anything else is validated, so a caller attempting to
     assert consent is told so rather than discovering it after fixing an
     unrelated field. `rest` catches it however it is spelled, because the old
     parameter name is exactly the one existing code would reach for. */
  for (const forbidden of ["consent", "emailConsent", "consentState", "suppressed", "optedIn"]) {
    if (Object.prototype.hasOwnProperty.call(rest, forbidden)) {
      throw fail("MARKETING_CONSENT_CALLER_SUPPLIED",
        `Consent cannot be supplied by the caller. Remove "${forbidden}" — marketing permission is read from the canonical GRAV consent record, and is written through services/marketing/marketingConsent.service.js.`,
        { field: forbidden });
    }
  }

  if (!str(gravPersonKey)) {
    throw fail("VALIDATION", "A Mautic projection needs the opaque GRAV person key.", { field: "gravPersonKey" });
  }

  const email = str(person.workEmail || person.email).toLowerCase();
  if (!email) {
    throw fail("VALIDATION", "A Mautic projection needs an email address.", { field: "person.workEmail" });
  }

  /* ── CONSENT, FROM THE RECORD ──────────────────────────────────────────
     Resolved before anything is written. A projection that happens first and is
     "cleaned up later" has already put the person in the marketing platform,
     which is the thing consent governs. Throws 403 carrying a stable
     `details.reasonCode` that the Data Health screen groups by. */
  let consent;
  try {
    consent = await consentService.assertMarketingEmailEligible({ companyId, gravPersonKey });
  } catch (err) {
    /* Recorded before rethrowing, so "who is blocked, and why" is answerable
       without re-resolving consent for every person in the company. Deliberately
       NOT counted as an attempt: nothing was attempted, and inflating the
       attempt count would make the retry budget look spent. */
    /* Fenced with the same lease as the rest of the attempt. Without it a
       consent refusal reached during a CLAIMED retry would be refused by the
       fence and the row would keep its old scheduled state — the person would
       stay in the retry backlog for ever despite having withdrawn. */
    await delivery.recordFailure({
      companyId, gravPersonKey, error: err, leaseToken: __leaseToken,
    }).catch(() => {});
    throw err;
  }

  const projection = buildProjection(person, gravPersonKey);

  /* ── THE IDENTITY EXISTS BEFORE ANYTHING IS ATTEMPTED ──────────────────
     Upserted here, carrying only the person key and where to reach them. No
     Mautic external is added — that waits until Mautic answers — so this cannot
     claim a link that does not exist. What it does is make the person
     discoverable: reconciliation walks identities, and a failure attached to
     nobody is a failure nobody can see or retry. */
  await MarketingIdentity.findOneAndUpdate(
    { companyId, gravPersonKey },
    { $set: { email, companyDomain: emailDomain(email) }, $setOnInsert: { companyId, gravPersonKey } },
    { upsert: true, new: true },
  );

  /* ── THE ATTEMPT OPENS HERE ────────────────────────────────────────────
     Before the first remote call, so a process that dies mid-call leaves the row
     IN_FLIGHT with no outcome — a visible state that says somebody should look —
     rather than a row that has never attempted anything. */
  const opened = await delivery.beginAttempt({ companyId, gravPersonKey, leaseToken: __leaseToken });
  if (opened.settled === false) {
    /* The lease moved on before this attempt even started. Another worker owns
       this person now; doing the work anyway would be the duplicate the claim
       exists to prevent. */
    throw fail("CONFLICT", "This projection's lease was taken by another worker before it began.", {
      gravPersonKey,
    });
  }

  try {
    return await project({
      client, companyId, gravPersonKey, person, projection, email, consent,
      leaseToken: __leaseToken,
    });
  } catch (err) {
    /* The attempt is resolved as a failure here, once, whatever went wrong and
       wherever in the remote conversation it happened. The classification and
       the backoff are the delivery service's business, not this function's. */
    await delivery.recordFailure({ companyId, gravPersonKey, error: err, leaseToken: __leaseToken }).catch(() => {});
    throw err;
  }
}

/**
 * The remote half of a projection, with no state-keeping of its own.
 *
 * Split out so `syncContact` above reads as what it is — validate, check
 * permission, open an attempt, do the work, record the outcome — instead of
 * burying the three Mautic paths inside the bookkeeping.
 */
async function project({ client, companyId, gravPersonKey, person, projection, email, consent, leaseToken = "" }) {
  /* ── 1. THE MAPPING ROW ────────────────────────────────────────────────── */
  let identity = await MarketingIdentity.findOne({ companyId, gravPersonKey });
  const mapped = identity?.externals?.find((e) => e.system === "mautic" && str(e.externalId));

  if (mapped) {
    const contact = await client.updateContact(mapped.externalId, projection);
    await stampSync(identity, mapped.externalId);
    await delivery.recordSuccess({ companyId, gravPersonKey, mauticContactId: str(mapped.externalId), leaseToken });
    return {
      contactId: str(mapped.externalId),
      created: false,
      matchedBy: "identity_mapping",
      contact,
      identity: identity.toObject(),
      /* What permitted this projection. Returned so a caller can show the basis
         rather than re-deriving it, and so a log can say which consent revision
         authorised a send. */
      consent: consentSummary(consent),
    };
  }

  /* ── 2. ONE EXACT EMAIL LOOKUP ─────────────────────────────────────────── */
  const found = await client.findContactByEmail(email);

  let contactId;
  let created;
  let matchedBy;
  let contact;

  if (found.found) {
    contactId = str(found.contact.id);
    contact = await client.updateContact(contactId, projection);
    created = false;
    matchedBy = "email_exact";
  } else {
    /* ── 3. CREATE ───────────────────────────────────────────────────────── */
    contact = await client.createContact(projection);
    contactId = str(contact?.id);
    if (!contactId) {
      throw fail("MAUTIC_REJECTED_WRITE", "Mautic created a contact but returned no id.");
    }
    created = true;
    matchedBy = "created";
  }

  /* ── THE MAPPING IS WRITTEN LAST, AND ALWAYS ──────────────────────────────
     After this, path 1 applies for ever and no search runs again. Writing it
     before the Mautic call would record a link to a contact that may not
     exist; not writing it at all is how the second call creates a duplicate. */
  /* The identity already exists — it was written before the remote call. This
     refreshes the routing address (an email change arrives here) and is where the
     Mautic external is appended, now that Mautic has actually answered. */
  identity = await MarketingIdentity.findOneAndUpdate(
    { companyId, gravPersonKey },
    {
      $set: { email, companyDomain: emailDomain(email) },
      $setOnInsert: { companyId, gravPersonKey },
    },
    { upsert: true, new: true },
  );
  if (!identity.externals.some((e) => e.system === "mautic" && str(e.externalId) === contactId)) {
    identity.externals.push({
      system: "mautic",
      externalId: contactId,
      /* `proven` because GRAV performed the write or the exact-email read
         itself. An inferred link would be false here. */
      proven: true,
      linkedAt: new Date(),
      lastSyncedAt: new Date(),
    });
    await identity.save();
  } else {
    await stampSync(identity, contactId);
  }

  await delivery.recordSuccess({ companyId, gravPersonKey, mauticContactId: contactId, leaseToken });

  console.log(`[mautic] contact ${matchedBy} for ${maskEmail(email)} → ${contactId}`);
  return {
    contactId, created, matchedBy, contact,
    identity: identity.toObject(),
    consent: consentSummary(consent),
  };
}

const emailDomain = (email) => {
  const at = str(email).indexOf("@");
  return at > 0 ? str(email).slice(at + 1).toLowerCase() : "";
};

async function stampSync(identity, externalId) {
  const row = identity.externals.find((e) => e.system === "mautic" && str(e.externalId) === str(externalId));
  if (!row) return;
  row.lastSyncedAt = new Date();
  row.lastSyncError = "";
  await identity.save();
}

/**
 * Put the contact in a segment, then READ BACK that it is there.
 *
 * The read-back is not belt and braces. Mautic answers `{success:true}` to an
 * enrolment whether or not it changed anything, so the write's own answer
 * cannot distinguish "enrolled" from "the request was accepted and quietly did
 * nothing". Proving membership is the only honest confirmation.
 */
async function enrolInSegment({ client, contactId, segment }) {
  const wanted = str(segment);
  if (!wanted) throw fail("VALIDATION", "A segment enrolment needs a segment.", { field: "segment" });

  let segmentId = /^\d+$/.test(wanted) ? wanted : "";
  if (!segmentId) {
    const all = await client.listSegments();
    const match = all.find((s) => str(s.alias) === wanted || str(s.name) === wanted);
    if (!match) {
      throw fail("NOT_FOUND", `Mautic has no segment "${wanted}".`, {
        segment: wanted, available: all.map((s) => str(s.alias)).filter(Boolean).slice(0, 20),
      });
    }
    segmentId = str(match.id);
  }

  await client.addContactToSegment(segmentId, contactId);
  const after = await client.contactSegments(contactId);
  const enrolled = after.some((s) => str(s.id) === segmentId);

  if (!enrolled) {
    throw fail("MAUTIC_REJECTED_WRITE",
      `Mautic accepted the enrolment but contact ${contactId} is not in segment ${segmentId}.`,
      { contactId, segmentId });
  }
  return { segmentId, enrolled: true, segments: after };
}

/** The minimum a caller needs to show WHY a projection was allowed. Not the
 *  whole consent row: it carries capture evidence that a caller has no reason
 *  to hold, and returning it would spread personal data for convenience. */
const consentSummary = (verdict) => ({
  state: verdict.state,
  recordedAt: verdict.record?.recordedAt || null,
  revision: verdict.record?.revision || null,
  noticeVersion: verdict.record?.noticeVersion || "",
});

module.exports = {
  syncContact, enrolInSegment, buildProjection, consentSummary,
  PROJECTION_FIELDS, EXTERNAL_KEY_FIELD,
};
