// services/marketing/handoverContract.js
//
// WHAT A HANDOVER MUST CONTAIN BEFORE SALES IS ASKED TO LOOK AT IT.
//
// Pure: no database, no request, no clock beyond the one it is handed. It
// takes a submitted package and either returns a normalised one or refuses it
// by name. Everything it enforces is a business rule from
// `docs/product/marketing-app-mautic-plan.md` §4 and §7, and every refusal
// says which rule and which field, because "invalid handover" is not something
// a marketer can act on.
//
// ── THE THREE GATES, IN ORDER ──────────────────────────────────────────────
//   1. CONTRACT   — is the package complete enough to be a handover at all?
//   2. PERMISSION — may this person be handed over at all?
//   3. THRESHOLD  — has this person actually shown interest?
//
// Order matters. A package missing a work email cannot be permission-checked
// (there is nothing to check the permission of), and a person who opted out
// must be refused before their engagement is discussed, so a refusal never
// reads as "not interested enough" when the truth is "asked us to stop".
"use strict";

const { fail } = require("../storePurchase/errors");
const {
  CONSENT_STATE_CODES,
  CONSENT_STATES_ALLOWING_HANDOVER,
  INTENT_EVENT_KIND_CODES,
  EXPLICIT_REQUEST_KINDS,
  MEANINGFUL_ENGAGEMENT_KINDS,
} = require("../../constants/marketing");

const str = (v) => String(v ?? "").trim();
const lower = (v) => str(v).toLowerCase();

/* Normalisers deliberately identical in behaviour to the Sales side's
   (services/crmDuplicates.js). Duplicate matching compares what THIS produces
   with what the Lead model's own pre-save hook produced, and two normalisers
   that merely happen to agree today will drift the first time either changes.
   They are re-stated rather than imported because importing a Sales service
   into Marketing is the coupling this application is arranged to avoid; the
   test suite asserts the two agree. */
const normalizeName = (s) => lower(s).replace(/[^a-z0-9]+/g, " ").trim();
function normalizePhone(s) {
  const d = str(s).replace(/\D+/g, "");
  return d.length > 10 ? d.slice(-10) : d;
}
function domainOf(value) {
  const v = lower(value);
  if (!v) return "";
  const at = v.indexOf("@");
  if (at >= 0) return v.slice(at + 1).replace(/\/.*$/, "");
  return v.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
}

/* A free-mail domain is not a company domain, and treating one as such would
   match every gmail user at one organisation to every other. Small, obvious
   list: this is a matching heuristic, not an email-provider registry. */
const CONSUMER_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.in", "outlook.com",
  "hotmail.com", "live.com", "icloud.com", "aol.com", "protonmail.com",
  "rediffmail.com", "zoho.com",
]);

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/* ═══ 1. CONTRACT ══════════════════════════════════════════════════════════ */

/**
 * Normalise and validate a submitted handover package.
 *
 * @param {object} input   the marketer's (or intake service's) package
 * @returns {object} the normalised package
 * @throws  a 400 naming the field and the rule
 */
function normalizePackage(input = {}) {
  const company = input.company || {};
  const person = input.person || {};
  const marketing = input.marketing || {};
  const permission = input.permission || {};

  const companyName = str(company.name);
  const website = str(company.website);
  const firstName = str(person.firstName);
  const lastName = str(person.lastName);
  const workEmail = lower(person.workEmail);
  const workPhone = str(person.workPhone);

  /* ── THE ORGANISATION ──────────────────────────────────────────────────
     A company name is required. Sales' own Prospect rule is "a company name
     OR a first name", and this is deliberately stricter: a Prospect a
     salesperson captured from a phone call may legitimately be one person
     whose employer is not yet known, but a Prospect MARKETING is vouching for
     has been through a campaign, a form and an assessment — if none of that
     established who they work for, the account-fit assessment is not an
     assessment. */
  if (!companyName) {
    throw fail("VALIDATION", "A handover needs the organisation's name.", { field: "company.name" });
  }

  /* ── THE PERSON ────────────────────────────────────────────────────────
     A name and at least one WORK contact detail. "Work" is the point: Sales
     is being asked to make a business contact, and a personal address
     collected by a form is not one. */
  if (!firstName) {
    throw fail("VALIDATION", "A handover needs the person's first name.", { field: "person.firstName" });
  }
  if (!workEmail && !workPhone) {
    throw fail(
      "VALIDATION",
      "A handover needs a work email address or a work phone number — Sales cannot make contact without one.",
      { field: "person.workEmail" },
    );
  }
  if (workEmail && !EMAIL_SHAPE.test(workEmail)) {
    throw fail("VALIDATION", "That work email address is not a valid address.", { field: "person.workEmail" });
  }

  /* ── SOURCE AND CAMPAIGN ───────────────────────────────────────────────
     Attribution is not decoration: it is how Sales' answer is fed back to the
     campaign that produced the handover. A handover that cannot name its
     campaign teaches Marketing nothing, which defeats the whole loop. */
  const campaignName = str(marketing.campaignName);
  const source = str(marketing.source);
  if (!source) {
    throw fail("VALIDATION", "A handover needs the marketing source it came from.", { field: "marketing.source" });
  }
  if (!campaignName) {
    throw fail("VALIDATION", "A handover needs the campaign it came from.", { field: "marketing.campaignName" });
  }

  /* ── PERMISSION ────────────────────────────────────────────────────────
     Absent is `unknown`, never `opted_in`. A default that grants permission is
     how a consent record stops being a consent record. */
  const emailConsent = str(permission.emailConsent) || "unknown";
  const phoneConsent = str(permission.phoneConsent) || "unknown";
  for (const [field, value] of [["emailConsent", emailConsent], ["phoneConsent", phoneConsent]]) {
    if (!CONSENT_STATE_CODES.includes(value)) {
      throw fail("VALIDATION", `"${value}" is not a marketing permission state.`, { field: `permission.${field}` });
    }
  }

  /* ── ACTIVITIES ────────────────────────────────────────────────────────
     Each one needs a kind this application understands and the time it
     happened. An activity with no timestamp cannot support a recency claim,
     and a recency claim is most of what a handover is asserting. */
  const activities = (Array.isArray(input.activities) ? input.activities : []).map((a, i) => {
    const kind = str(a?.kind);
    if (!INTENT_EVENT_KIND_CODES.includes(kind)) {
      throw fail("VALIDATION", `Activity ${i + 1} has an unknown kind "${kind}".`, { field: `activities.${i}.kind` });
    }
    const occurredAt = a?.occurredAt ? new Date(a.occurredAt) : null;
    if (!occurredAt || Number.isNaN(occurredAt.getTime())) {
      throw fail("VALIDATION", `Activity ${i + 1} needs the time it happened.`, { field: `activities.${i}.occurredAt` });
    }
    return {
      kind,
      occurredAt,
      campaignName: str(a.campaignName),
      assetName: str(a.assetName),
      detail: str(a.detail),
      sourceEventId: str(a.sourceEventId),
    };
  }).sort((a, b) => b.occurredAt - a.occurredAt);

  const domain = domainOf(website) || (workEmail ? domainOf(workEmail) : "");
  const companyDomain = CONSUMER_DOMAINS.has(domain) ? "" : domain;

  return {
    company: {
      name: companyName,
      website,
      domain: companyDomain,
      country: str(company.country),
      sizeBand: str(company.sizeBand),
      industry: str(company.industry),
    },
    person: {
      firstName,
      lastName,
      jobTitle: str(person.jobTitle),
      workEmail,
      workPhone,
      linkedinUrl: str(person.linkedinUrl),
    },
    marketing: {
      sourceSystem: str(marketing.sourceSystem) || "mautic",
      source,
      campaignId: str(marketing.campaignId),
      campaignName,
      assetName: str(marketing.assetName),
      firstSeenAt: marketing.firstSeenAt ? new Date(marketing.firstSeenAt) : null,
      lastEngagedAt: activities.length ? activities[0].occurredAt
        : (marketing.lastEngagedAt ? new Date(marketing.lastEngagedAt) : null),
    },
    permission: {
      emailConsent,
      phoneConsent,
      capturedAt: permission.capturedAt ? new Date(permission.capturedAt) : null,
      capturedSource: str(permission.capturedSource),
      noticeVersion: str(permission.noticeVersion),
      suppressed: Boolean(permission.suppressed),
      suppressionReason: str(permission.suppressionReason),
    },
    provenance: (Array.isArray(input.provenance) ? input.provenance : [])
      .filter((p) => str(p?.provider))
      .map((p) => ({
        provider: str(p.provider),
        providerRecordId: str(p.providerRecordId),
        retrievedAt: p.retrievedAt ? new Date(p.retrievedAt) : new Date(),
        fields: (Array.isArray(p.fields) ? p.fields : []).map(str).filter(Boolean),
        lookupReference: str(p.lookupReference),
      })),
    activities,
    topicsOfInterest: [...new Set(
      (Array.isArray(input.topicsOfInterest) ? input.topicsOfInterest : []).map(str).filter(Boolean),
    )],
    sourceEnquiry: sourceEnquiryOf(input.sourceEnquiry),
    matchKeys: {
      normalizedEmail: workEmail,
      normalizedPhone: normalizePhone(workPhone),
      companyDomain,
      normalizedCompanyName: normalizeName(companyName),
      externalContactId: str(input.externalContactId),
    },
    sourceEventIds: [...new Set(activities.map((a) => a.sourceEventId).filter(Boolean))],
  };
}

/* A lead-source enquiry's own request. Optional, and absent for a Mautic
   handover. Bounded here so a long message is shortened, not refused. */
function sourceEnquiryOf(e) {
  if (!e || typeof e !== "object" || !str(e.source)) return null;
  const date = (v) => {
    const d = v ? new Date(v) : null;
    return d && !Number.isNaN(d.getTime()) ? d : null;
  };
  const n = Number(e.callDurationSeconds);
  return {
    source: str(e.source).slice(0, 40),
    sourceRef: str(e.sourceRef).slice(0, 64),
    channel: str(e.channel).slice(0, 80),
    kind: str(e.kind).slice(0, 40),
    submittedAt: date(e.submittedAt),
    submittedAtText: str(e.submittedAtText).slice(0, 40),
    submittedAtProvenance: ["source", "reviewer_confirmed"].includes(str(e.submittedAtProvenance)) ? str(e.submittedAtProvenance) : "",
    submittedAtConfirmedBy: str(e.submittedAtConfirmedBy).slice(0, 200),
    submittedAtConfirmedAt: date(e.submittedAtConfirmedAt),
    submittedAtConfirmationNote: str(e.submittedAtConfirmationNote).slice(0, 500),
    receivedAt: date(e.receivedAt),
    subject: str(e.subject).slice(0, 500),
    productName: str(e.productName).slice(0, 300),
    categoryName: str(e.categoryName).slice(0, 300),
    message: str(e.message).slice(0, 5000),
    callDurationSeconds: e.callDurationSeconds !== null && e.callDurationSeconds !== undefined && Number.isInteger(n) && n >= 0 ? n : null,
  };
}

/* ═══ 2. PERMISSION ════════════════════════════════════════════════════════ */

/**
 * May this person be handed to Sales at all?
 *
 * Suppression wins over everything, and conflicts resolve toward suppression
 * (product plan §7). An `unknown` email consent does NOT block a handover — a
 * handover is not a marketing send, and refusing it would mean a person who
 * telephoned and asked for a callback could never reach a salesperson — but it
 * travels to Sales as `unknown` and is shown as such.
 *
 * @returns {{allowed:boolean, reason:string}}
 */
function checkPermission(pkg) {
  const { permission } = pkg;
  if (permission.suppressed) {
    return { allowed: false, reason: "This person is suppressed from marketing contact." };
  }
  if (!CONSENT_STATES_ALLOWING_HANDOVER.has(permission.emailConsent)) {
    return {
      allowed: false,
      reason: `Marketing email permission is "${permission.emailConsent}" — this person cannot be handed to Sales through a campaign.`,
    };
  }
  return { allowed: true, reason: "" };
}

/* ═══ 3. THRESHOLD ═════════════════════════════════════════════════════════ */

/* "A single open or general page view is not enough. A handover needs an
   explicit request … or a reviewed combination of fit, recency and repeated
   meaningful engagement." (product plan §4). Two meaningful engagements is the
   smallest honest reading of "repeated", and opens and page views count
   towards neither number. */
const MEANINGFUL_ENGAGEMENTS_REQUIRED = 2;
const RECENCY_DAYS = 30;

/**
 * Has this person shown enough to be worth a salesperson's time?
 *
 * @param {object} pkg   a normalised package
 * @param {Date}   now
 * @returns {{met:boolean, basis:string, reason:string, explicitRequests:Array, meaningful:Array}}
 */
function checkThreshold(pkg, now = new Date()) {
  const cutoff = new Date(now.getTime() - RECENCY_DAYS * 24 * 60 * 60 * 1000);
  const recent = pkg.activities.filter((a) => a.occurredAt >= cutoff);

  const explicitRequests = recent.filter((a) => EXPLICIT_REQUEST_KINDS.has(a.kind));
  const meaningful = recent.filter((a) => MEANINGFUL_ENGAGEMENT_KINDS.has(a.kind));

  if (explicitRequests.length) {
    return { met: true, basis: "explicit_request", reason: "", explicitRequests, meaningful };
  }
  if (meaningful.length >= MEANINGFUL_ENGAGEMENTS_REQUIRED) {
    return { met: true, basis: "repeated_engagement", reason: "", explicitRequests, meaningful };
  }
  return {
    met: false,
    basis: "",
    explicitRequests,
    meaningful,
    reason: pkg.activities.length
      ? `This person has not made a request, and has ${meaningful.length} meaningful engagement${meaningful.length === 1 ? "" : "s"} in the last ${RECENCY_DAYS} days. An open or a page view is not enough.`
      : `No marketing activity is recorded for this person in the last ${RECENCY_DAYS} days.`,
  };
}

module.exports = {
  normalizePackage,
  checkPermission,
  checkThreshold,
  normalizeName,
  normalizePhone,
  domainOf,
  CONSUMER_DOMAINS,
  MEANINGFUL_ENGAGEMENTS_REQUIRED,
  RECENCY_DAYS,
};
