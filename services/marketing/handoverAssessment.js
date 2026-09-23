// services/marketing/handoverAssessment.js
//
// WHY THIS PERSON, IN WORDS A SALESPERSON CAN ARGUE WITH.
//
// ── RULES, NOT A MODEL ─────────────────────────────────────────────────────
// The roadmap is explicit that this slice carries "one transparent, rule-based
// handover-readiness explanation; no generative content and no opaque
// predictive model". So there is no score. There are two bands, each with the
// factors that produced it listed beside it, and a sentence in plain language.
//
// A number would have been easier and worse. "Score 74" invites a threshold
// nobody can defend and cannot be disagreed with, because there is nothing in
// it to disagree WITH. A band whose factors are printed can be wrong out loud.
//
// ── MISSING DATA REDUCES CONFIDENCE; IT IS NEVER EVIDENCE ──────────────────
// A person whose employer size is unknown is `unknown` fit, not `weak` fit.
// The plan's intelligence-safety contract says missing data "may reduce
// confidence; it may not be invented or treated as negative evidence", and the
// difference shows up in exactly this function: `weak` tells a salesperson not
// to bother, and saying it because nobody filled a form in is a lie.
//
// ── VERSIONED ──────────────────────────────────────────────────────────────
// `RULES_VERSION` is stamped onto every assessment. Changing the rules must not
// silently rewrite what an old handover claimed, and a handover that says which
// rules judged it can still be read years later.
"use strict";

const {
  EXPLICIT_REQUEST_KINDS,
  MEANINGFUL_ENGAGEMENT_KINDS,
} = require("../../constants/marketing");

const RULES_VERSION = "handover-readiness-1.0";

const str = (v) => String(v ?? "").trim();
const HOUR = 60 * 60 * 1000;

/* Which explicit request means what, in a salesperson's terms. Used for the
   plain-language reason, so it reads as a sentence rather than an enum. */
const REQUEST_PHRASE = {
  quotation_requested: "asked for a quotation",
  sample_requested: "asked for a sample",
  callback_requested: "asked to be called back",
  consultation_requested: "asked for a consultation",
  form_submitted: "submitted an enquiry form",
};

/* ── ACCOUNT FIT ────────────────────────────────────────────────────────────
   Fit is about the ORGANISATION: is this the kind of buyer this business
   sells to, and is the person senior enough to be worth a call? Deliberately
   nothing about engagement — that is intent, and folding the two into one
   number is how "they clicked a lot" starts reading as "they are a good
   customer". */
const SENIOR_TITLE = /\b(head|director|manager|chief|vp|vice president|owner|founder|partner|principal|proprietor|ceo|coo|cfo|md|managing)\b/i;
const PROCUREMENT_TITLE = /\b(procure|purchas|sourcing|buyer|supply|merchandis|admin|facilit)\w*/i;

function assessAccountFit(pkg) {
  const factors = [];
  let known = 0;
  let positive = 0;

  const industry = str(pkg.company.industry);
  if (industry) {
    known += 1;
    positive += 1;
    factors.push(`Industry recorded as ${industry}.`);
  }

  const sizeBand = str(pkg.company.sizeBand);
  if (sizeBand) {
    known += 1;
    positive += 1;
    factors.push(`Organisation size band ${sizeBand}.`);
  }

  if (pkg.company.domain) {
    known += 1;
    positive += 1;
    factors.push(`Work domain ${pkg.company.domain} matches the organisation.`);
  } else if (pkg.person.workEmail) {
    /* A free-mail address is a real, recorded observation and does count
       against fit — unlike an ABSENT field, which does not. */
    known += 1;
    factors.push("The contact address is a personal mailbox, not a company domain.");
  }

  const jobTitle = str(pkg.person.jobTitle);
  if (jobTitle) {
    known += 1;
    if (SENIOR_TITLE.test(jobTitle) || PROCUREMENT_TITLE.test(jobTitle)) {
      positive += 1;
      factors.push(`${jobTitle} is a buying or decision-making role.`);
    } else {
      factors.push(`${jobTitle} may not be the buying contact.`);
    }
  }

  /* Fewer than two known facts is not a weak account — it is an unknown one. */
  if (known < 2) {
    return {
      accountFit: "unknown",
      accountFitFactors: factors.length ? factors : ["Nothing is recorded about the organisation yet."],
    };
  }
  if (positive >= 3) return { accountFit: "strong", accountFitFactors: factors };
  if (positive >= 1) return { accountFit: "possible", accountFitFactors: factors };
  return { accountFit: "weak", accountFitFactors: factors };
}

/* ── INTENT ─────────────────────────────────────────────────────────────────
   Intent is about the PERSON'S BEHAVIOUR, and only about what they did — never
   about who they work for. An explicit ask outranks any amount of clicking,
   because it is the person saying what they want rather than us inferring it. */
function assessIntent(pkg, now = new Date()) {
  const factors = [];
  const activities = pkg.activities || [];
  const explicit = activities.filter((a) => EXPLICIT_REQUEST_KINDS.has(a.kind));
  const meaningful = activities.filter((a) => MEANINGFUL_ENGAGEMENT_KINDS.has(a.kind));

  for (const a of explicit.slice(0, 3)) {
    factors.push(`${REQUEST_PHRASE[a.kind] || a.kind.replace(/_/g, " ")} on ${a.occurredAt.toISOString().slice(0, 10)}.`);
  }
  if (meaningful.length) {
    factors.push(`${meaningful.length} meaningful engagement${meaningful.length === 1 ? "" : "s"} with campaign material.`);
  }
  if (pkg.topicsOfInterest?.length) {
    factors.push(`Interested in ${pkg.topicsOfInterest.join(", ")}.`);
  }

  const newest = activities.length ? activities[0].occurredAt : null;
  const freshnessHours = newest ? Math.max(0, Math.round((now - newest) / HOUR)) : null;
  if (freshnessHours !== null) {
    factors.push(`Most recent activity ${freshnessHours} hour${freshnessHours === 1 ? "" : "s"} ago.`);
  }

  let intent = "low";
  if (explicit.length) intent = "explicit_request";
  else if (meaningful.length >= 3) intent = "high";
  else if (meaningful.length >= 1) intent = "moderate";

  if (!factors.length) factors.push("No marketing activity is recorded.");
  return { intent, intentFactors: factors, evidenceFreshnessHours: freshnessHours, explicit, meaningful };
}

/* ── THE SENTENCE ───────────────────────────────────────────────────────────
   Assembled from the same facts the bands were derived from, so the prose and
   the bands cannot disagree. Written for a salesperson opening the Prospect
   cold, which is why it names the organisation and the ask rather than the
   campaign mechanics. */
function buildReason(pkg, intent) {
  const who = [pkg.person.firstName, pkg.person.lastName].filter(Boolean).join(" ");
  const role = pkg.person.jobTitle ? `, ${pkg.person.jobTitle},` : "";
  const org = pkg.company.name;

  const ask = intent.explicit.length
    ? (REQUEST_PHRASE[intent.explicit[0].kind] || "made a request")
    : null;

  if (ask) {
    const topics = pkg.topicsOfInterest?.length ? ` about ${pkg.topicsOfInterest.join(" and ")}` : "";
    return `${who}${role} at ${org} ${ask}${topics} through the ${pkg.marketing.campaignName} campaign.`;
  }
  const count = intent.meaningful.length;
  const topics = pkg.topicsOfInterest?.length ? ` on ${pkg.topicsOfInterest.join(" and ")}` : "";
  return `${who}${role} at ${org} engaged with the ${pkg.marketing.campaignName} campaign ${count} time${count === 1 ? "" : "s"}${topics} without making a direct request.`;
}

/* ── THE RECOMMENDATION ─────────────────────────────────────────────────────
   A suggested FIRST CONTACT and nothing more. No code in this function can
   recommend a price, a quotation or a negotiation, because Marketing may not
   recommend those (product plan §3). */
function recommendAction(fit, intent) {
  if (intent.intent === "explicit_request") {
    return fit.accountFit === "weak"
      ? "call_within_three_business_days"
      : "call_within_one_business_day";
  }
  if (fit.accountFit === "unknown") return "research_before_contact";
  if (fit.accountFit === "strong" && intent.intent === "high") return "call_within_three_business_days";
  return "email_introduction";
}

/**
 * The whole assessment, from a normalised package.
 *
 * @param {object} pkg   a package from handoverContract.normalizePackage
 * @param {Date}   now
 */
function assess(pkg, now = new Date()) {
  const fit = assessAccountFit(pkg);
  const intent = assessIntent(pkg, now);
  return {
    accountFit: fit.accountFit,
    accountFitFactors: fit.accountFitFactors,
    intent: intent.intent,
    intentFactors: intent.intentFactors,
    handoverReason: buildReason(pkg, intent),
    recommendedAction: recommendAction(fit, intent),
    evidenceFreshnessHours: intent.evidenceFreshnessHours,
    rulesVersion: RULES_VERSION,
  };
}

module.exports = { assess, assessAccountFit, assessIntent, recommendAction, RULES_VERSION };
