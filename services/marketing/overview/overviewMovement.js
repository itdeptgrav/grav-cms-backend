// services/marketing/overview/overviewMovement.js
//
// MARKETING-TO-SALES MOVEMENT, FROM EVIDENCE GRAV ACTUALLY HOLDS.
//
// ── THIS IS NOT A FUNNEL ───────────────────────────────────────────────────
// A funnel implies one cohort descending through stages, so that each stage is
// a subset of the one above it and dividing two of them gives a conversion
// rate. None of that is true here, and pretending otherwise would put a
// confident, wrong percentage on a dashboard:
//
//   The people who engaged in these dates and the handovers submitted in these
//   dates are different populations. A prospect handed over on Tuesday may
//   have engaged last month; somebody who engaged today may be handed over in
//   March or never.
//
//   A handover's CURRENT state is a fact about now, not about the period. Of
//   the handovers submitted in these dates, the ones sitting in "awaiting
//   review" today are not the ones that were awaiting review at any point
//   during it.
//
//   Blocked prospects were never submitted at all, so they are not a residue
//   of the submitted count — they are a separate thing that happened instead.
//
// So every figure here is an independently measured count, each with the
// sentence that defines it, and the response carries `coherentFunnel: false`
// and no percentages. A reader can add them up if they want to; GRAV will not
// do it for them and call the result a conversion rate.
//
// ── AND "ENGAGEMENT" MEANS WHAT IT ALREADY MEANT ───────────────────────────
// The repository has one definition and this file uses it rather than writing
// a second. Meaningful engagement is `email_clicked`; an explicit request is
// one of the five asks. A possible email open is neither, and the constants
// say so in the kind's own label — "Email opened (possible)". A contact GRAV
// synchronised into the marketing engine is not engagement either: that is an
// outbound write by GRAV, not an act by a person.
"use strict";

const mongoose = require("mongoose");

const MarketingEventReceipt = require("../../../models/CMS_Models/Marketing/MarketingEventReceipt");
const ProspectHandover = require("../../../models/CMS_Models/Marketing/ProspectHandover");
const handovers = require("../handoverReadModel.service");
const { destinationFor } = require("../../../constants/marketingOverview");
const {
  MEANINGFUL_ENGAGEMENT_KINDS,
  EXPLICIT_REQUEST_KINDS,
  TELEMETRY_ONLY_KINDS,
  HANDOVER_STATES,
} = require("../../../constants/marketing");

const HANDOVER_LABEL = Object.fromEntries(HANDOVER_STATES.map((s) => [s.code, s.label]));

/* The kinds that count as a person doing something. The union of the two
   existing sets and nothing else — a third set defined here would be a second
   opinion about what engagement is, and the thresholds elsewhere would go on
   using the first one. */
const ENGAGING_KINDS = Object.freeze([
  ...EXPLICIT_REQUEST_KINDS,
  ...MEANINGFUL_ENGAGEMENT_KINDS,
]);

/* Stated in the response so a reader can see what was excluded and why, rather
   than wondering why a number is smaller than the email report's. */
const NOT_ENGAGEMENT = Object.freeze([...TELEMETRY_ONLY_KINDS]);

/**
 * Distinct people who did something meaningful in the range.
 *
 * ── COUNTED FROM RECEIPTS, NOT FROM THE EVENT LEDGER ──────────────────────
 * The ledger records who was identifiable when an event arrived and is never
 * rewritten, so a person GRAV could not name in January stays nameless on
 * January's rows even after they are recognised in February. The receipt is
 * the half that carries late resolution.
 *
 * Counting the ledger would therefore undercount real people. Counting
 * receipts counts the people GRAV can actually name — and an event whose
 * person is still unresolved is deliberately NOT counted as a person, because
 * GRAV does not know who they are and one unresolved event is not evidence of
 * one human being.
 */
async function engagedPeople({ companyId, from, to }) {
  const company = new mongoose.Types.ObjectId(String(companyId));
  const start = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T23:59:59.999Z`);

  const rows = await MarketingEventReceipt.aggregate([
    {
      /* ── COMPANY IN THE MATCH, ALWAYS ─────────────────────────────────
         An aggregate without it counts every company's people into one
         number, and the result looks entirely plausible. */
      $match: {
        companyId: company,
        kind: { $in: ENGAGING_KINDS },
        occurredAt: { $gte: start, $lte: end },
        /* A person GRAV cannot name is not a person GRAV may count. */
        gravPersonKey: { $nin: ["", null] },
      },
    },
    /* One row per person however many times they acted — clicking four links
       is one interested person, not four. */
    { $group: { _id: "$gravPersonKey" } },
    { $count: "people" },
  ]);

  return rows.length ? rows[0].people : 0;
}

/** Handovers whose submission happened inside the range, grouped by where they are now. */
async function handoversSubmittedIn({ companyId, from, to }) {
  const company = new mongoose.Types.ObjectId(String(companyId));
  const start = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T23:59:59.999Z`);

  const rows = await ProspectHandover.aggregate([
    {
      $match: {
        companyId: company,
        submittedAt: { $gte: start, $lte: end },
      },
    },
    { $group: { _id: "$state", n: { $sum: 1 } } },
  ]);

  /* Every state present, zeroes measured — the house rule from the existing
     summary: a zero here is a counted zero, never a stand-in for a read that
     did not happen. */
  const byState = Object.fromEntries(HANDOVER_STATES.map((s) => [s.code, 0]));
  let submitted = 0;
  for (const r of rows) {
    if (r._id in byState) byState[r._id] = r.n;
    submitted += r.n;
  }
  return { submitted, byState };
}

/** Prospects refused before they ever reached Sales, inside the range. */
async function blockedIn({ companyId, from, to }) {
  const company = new mongoose.Types.ObjectId(String(companyId));
  return ProspectHandover.countDocuments({
    companyId: company,
    state: "BLOCKED",
    /* Blocked rows were never submitted, so `submittedAt` is not their
       chronology — when the attempt was recorded is. */
    createdAt: { $gte: new Date(`${from}T00:00:00.000Z`), $lte: new Date(`${to}T23:59:59.999Z`) },
  });
}

const stage = (code, label, count, means) => ({ code, label, count, means });

/**
 * The movement block, plus the company-wide handover summary beside it.
 *
 * @param {object}   args
 * @param {ObjectId} args.companyId
 * @param {string}   args.from  YYYY-MM-DD
 * @param {string}   args.to    YYYY-MM-DD
 */
async function movementFor({ companyId, from, to }) {
  const [people, submitted, blocked, companyWide] = await Promise.all([
    engagedPeople({ companyId, from, to }),
    handoversSubmittedIn({ companyId, from, to }),
    blockedIn({ companyId, from, to }),
    /* The existing exact counts, whole-company and unfiltered. Reused rather
       than recomputed so the Overview and the Handovers page can never
       disagree about how many are waiting. */
    handovers.summaryFor({ companyId }),
  ]);

  const prospectMovement = {
    /* ── SAID PLAINLY, ON THE RESPONSE ──────────────────────────────────── */
    coherentFunnel: false,
    means: "These are independently measured counts, not stages of one funnel. The people who engaged in these dates and the prospects handed to Sales in these dates are different groups, and a prospect's current state is a fact about today rather than about this period. GRAV publishes no percentage between them because there is no cohort a percentage would describe.",
    range: { from, to },

    stages: [
      stage("engaged_people", "People who engaged", people,
        "Distinct people who clicked a marketing email or made an explicit request in these dates. Someone who acted several times is counted once."),
      stage("handovers_submitted", "Prospects handed to Sales", submitted.submitted,
        "Prospects submitted to Sales in these dates, whatever has happened to them since."),
      stage("awaiting_review", HANDOVER_LABEL.AWAITING_REVIEW, submitted.byState.AWAITING_REVIEW,
        "Of those submitted in these dates, the ones Sales has not decided on yet."),
      stage("accepted", HANDOVER_LABEL.ACCEPTED, submitted.byState.ACCEPTED,
        "Of those submitted in these dates, the ones Sales has accepted."),
      stage("returned", HANDOVER_LABEL.RETURNED, submitted.byState.RETURNED,
        "Of those submitted in these dates, the ones Sales sent back for nurture. They are Marketing's to work on again."),
      stage("rejected", HANDOVER_LABEL.REJECTED, submitted.byState.REJECTED,
        "Of those submitted in these dates, the ones Sales declined."),
      /* ── THE SIXTH STATE, PUBLISHED RATHER THAN FOLDED IN ──────────────
         `DUPLICATE_LINKED` is one of the four answers Sales may give and it is
         not a rejection: it means the person already exists in Sales. Adding
         it to "rejected" would report a successful match as a failure. */
      stage("linked_to_existing", HANDOVER_LABEL.DUPLICATE_LINKED, submitted.byState.DUPLICATE_LINKED,
        "Of those submitted in these dates, the ones Sales matched to a record it already had. Not a rejection."),
      stage("blocked", HANDOVER_LABEL.BLOCKED, blocked,
        "Prospects that could not be submitted to Sales in these dates. Each has a recorded reason, and none of them reached Sales at all."),
    ],

    /* What was deliberately left out of "engaged", named so the figure can be
       reconciled against an email report that counts differently. */
    notCountedAsEngagement: NOT_ENGAGEMENT.map((code) => ({
      kind: code,
      why: code === "email_opened"
        ? "An email open is a possible open and nothing more. It is the weakest evidence GRAV holds and it never counts as engagement on its own."
        : "Delivery and page telemetry record what GRAV or a mail server did, not something a person chose to do.",
    })).concat([{
      /* ── SAID WITHOUT THE SYSTEM'S OWN WORDS ──────────────────────────
         The thing being excluded here is a contact GRAV pushed out to the
         mailing system. Describing it as "synchronised into the marketing
         engine" would be accurate and useless: it names plumbing a marketer
         cannot act on, on the one page that exists to avoid that. What they
         need to know is simpler — GRAV did it, the person did not. */
      kind: "added_to_mailing",
      why: "Adding somebody to a mailing list is something GRAV did, not something that person chose to do. It is not engagement.",
    }]),

    /* Stated because the word is load-bearing and easy to misuse. */
    /* ── THE WORD THIS PAGE MUST NOT USE, AND WHY ─────────────────────────
       Named in one field, once, so a screen can show the distinction rather
       than a reader assuming it. Everywhere else these are "people". */
    peopleAreNotLeads: "These are people Marketing has evidence about. They are not Leads — a Lead exists only once Sales accepts a prospect and creates one.",
  };

  const handoverSummary = {
    total: companyWide.total,
    awaitingReview: companyWide.byState.AWAITING_REVIEW,
    accepted: companyWide.byState.ACCEPTED,
    returnedForNurture: companyWide.byState.RETURNED,
    rejected: companyWide.byState.REJECTED,
    linkedToExisting: companyWide.byState.DUPLICATE_LINKED,
    blockedBeforeSubmission: companyWide.byState.BLOCKED,
    scope: "company",
    means: "Every handover this company has, whenever it was submitted. These are the same counts the Handovers page shows.",
    /* From the one table that holds GRAV's screen addresses. Spelling it by
       hand here was how the campaign path drifted from the route the frontend
       serves without anything noticing. */
    destination: destinationFor("handovers"),
  };

  return { prospectMovement, handoverSummary, __anyHandovers: companyWide.total > 0, __anyEngagement: people > 0 };
}

module.exports = {
  movementFor,
  engagedPeople,
  handoversSubmittedIn,
  blockedIn,
  ENGAGING_KINDS,
  NOT_ENGAGEMENT,
};
