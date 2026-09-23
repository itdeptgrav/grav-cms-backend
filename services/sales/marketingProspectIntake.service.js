// services/sales/marketingProspectIntake.service.js
//
// SALES RECEIVES WHAT MARKETING PUBLISHED, AND CREATES THE PROSPECT ITSELF.
//
// ── THE HALF OF THE BOUNDARY THAT LIVES HERE ───────────────────────────────
// Marketing states a fact — this person is worth a salesperson's time, here is
// the evidence. This is the only code that reads those events and writes a
// Sales record because of one. Marketing owns the event; Sales owns the
// mutation. It is the same arrangement as services/merchandising/
// handoverIntake.service.js, and it exists for the same reason: a rule about
// what a Prospect looks like must be changeable by editing Sales.
//
// ── WHAT IT CREATES, AND WHAT IT REFUSES TO ────────────────────────────────
// It creates ONE Lead with `captureStatus: "draft"` — a Prospect — and
// `reviewStatus: "researching"`, which is where a Prospect nobody has
// submitted for approval belongs.
//
// It does not touch `qualificationState` beyond the schema default, does not
// call services/leadReview.js or services/leadQualification.js, creates no
// Activity, no Account, no Contact, no Enquiry, no Sales Journey and no
// quotation. Those two services remain the only writers of a Lead's lifecycle,
// and neither is reachable from here — which is what makes "Marketing cannot
// create an Active Lead" true by construction rather than by discipline.
//
// The "awaiting review" the product plan asks for is the RECEIPT's undecided
// state, deliberately not `reviewStatus: "submitted"`. That value already means
// something else in Sales — a salesperson has asked a HOD to approve their
// Prospect as an Active Lead — and borrowing it would have put a Marketing
// handover in a HOD's approval queue where a single click makes it an Active
// Lead. Two different reviews, two different axes.
//
// ── IDEMPOTENCY ────────────────────────────────────────────────────────────
// The receipt is unique on (companyId, handoverRef) and the Lead carries a
// matching partial unique index. A redelivered event finds the receipt and
// changes nothing; a race that somehow passed the receipt is stopped by the
// Lead index. Two guarantees, because one is about events and one is about
// state, and they fail differently.
//
// ── AND A STRONG DUPLICATE IS LINKED, NOT DUPLICATED ───────────────────────
// "If the person already belongs to Sales, the signal is attached to the
// existing record and no duplicate Prospect is created." A HIGH-confidence
// match on an identity that means "the same person or desk" — an email
// address, a phone number — links. A medium match (a shared company name or
// domain) does not: two people at one organisation are two prospects, and
// collapsing them would lose the second person entirely.
"use strict";

const Lead = require("../../models/CMS_Models/Sales/Lead");
const Account = require("../../models/CMS_Models/Sales/Account");
const Contact = require("../../models/CMS_Models/Sales/Contact");
const {
  MarketingHandoverReceipt,
} = require("../../models/CMS_Models/Sales/MarketingProspectIntake");
const { createWithRef } = require("../leadRef");
const { findProspectDuplicates } = require("../crmDuplicates");
const { createServiceContext } = require("../companyContext/serviceScope.service");
const { fail } = require("../storePurchase/errors");
const { MARKETING_EVENT_KINDS } = require("../../constants/marketing");

const str = (v) => String(v ?? "").trim();

/* The Lead `source` code a marketing handover always carries. Additive to the
   Lead model's enum in the same change that added this file — none of the
   pre-existing codes says "the Marketing application vouched for this person",
   and picking the closest wrong one would corrupt every source report. */
const HANDOVER_LEAD_SOURCE = "marketing_campaign";

/* A handover that came from a LEAD SOURCE rather than a campaign carries that
   source's own Lead code, so an IndiaMART buyer enquiry is never counted as a
   Marketing campaign in a source report. Keyed on the handover's
   `marketing.sourceSystem` and only when it carries the source enquiry. */
const LEAD_SOURCE_FOR_SYSTEM = Object.freeze({ indiamart: "indiamart" });

function leadSourceOf(pkg) {
  const system = str(pkg.marketing?.sourceSystem);
  const code = pkg.sourceEnquiry && str(pkg.sourceEnquiry.source) === system ? LEAD_SOURCE_FOR_SYSTEM[system] : null;
  return code || HANDOVER_LEAD_SOURCE;
}

/** The Prospect fields a handover fills in. Nothing outside this list is
 *  written, so a later Marketing field cannot silently start populating a
 *  Sales column nobody agreed to. */
function leadFromPackage(pkg) {
  const person = pkg.person || {};
  const company = pkg.company || {};
  const marketing = pkg.marketing || {};

  return {
    captureStatus: "draft",
    reviewStatus: "researching",
    prospectType: company.name ? "company" : "individual",

    firstName: str(person.firstName),
    lastName: str(person.lastName),
    designation: str(person.jobTitle),
    email: str(person.workEmail).toLowerCase(),
    phone: str(person.workPhone),

    company: str(company.name),
    website: str(company.website),

    source: leadSourceOf(pkg),
    /* For a lead-source enquiry: the channel it came through (Direct
       enquiry, Phone call, WhatsApp enquiry), and no campaign — it was not
       one. A campaign handover is unchanged. */
    sourceDetails: leadSourceOf(pkg) === HANDOVER_LEAD_SOURCE
      ? str(marketing.source)
      : (str(pkg.sourceEnquiry?.channel) || str(marketing.source)),
    campaignOrEvent: leadSourceOf(pkg) === HANDOVER_LEAD_SOURCE ? str(marketing.campaignName) : undefined,

    /* The one thing that made Marketing believe this was real, in the Sales
       vocabulary that already exists for it. `interestSignal` is a fixed enum
       a business can count, so it is mapped rather than invented. */
    ...interestFrom(pkg),

    /* A salesperson's first read of what this might be about. Deliberately
       `possibleNeed` and not `requirements[]` — a requirement is a structured
       commitment made on an Active Lead after a conversation, and Marketing
       has had no conversation. */
    possibleNeed: needFrom(pkg),

    contacts: person.firstName
      ? [{
        name: [person.firstName, person.lastName].filter(Boolean).join(" "),
        jobTitle: str(person.jobTitle),
        email: str(person.workEmail).toLowerCase() || undefined,
        phone: str(person.workPhone) || undefined,
        isPrimary: true,
        status: "active",
      }]
      : undefined,
  };
}

/* A buyer enquiry's own request, in the buyer's words, when the handover came
   from a lead source; otherwise the topics, as before. Only Sales' existing
   `possibleNeed` text is filled — no new Sales column. */
function needFrom(pkg) {
  const e = pkg.sourceEnquiry;
  if (e && str(e.source)) {
    /* The time, with where it came from — never a guess. */
    const at = e.submittedAt ? `${new Date(e.submittedAt).toISOString().slice(0, 16).replace("T", " ")} UTC` : "";
    const asSent = str(e.submittedAtText) ? `source time "${str(e.submittedAtText)}"` : "";
    let when = "time not stated";
    if (at && str(e.submittedAtProvenance) === "reviewer_confirmed") {
      when = `${at}, confirmed by ${str(e.submittedAtConfirmedBy) || "a reviewer"}${asSent ? `; ${asSent}` : ""}`;
    } else if (at) when = at;
    else if (asSent) when = asSent;
    const lines = [
      `${str(e.channel) || "Enquiry"} via ${str(pkg.marketing?.source) || str(e.source)} (${when}, ref ${str(e.sourceRef)}).`,
      str(e.productName) && `Product: ${str(e.productName)}.`,
      str(e.categoryName) && `Category: ${str(e.categoryName)}.`,
      str(e.subject) && `Subject: ${str(e.subject)}`,
      str(e.message) && `Message: ${str(e.message)}`,
      Number.isFinite(e.callDurationSeconds) && e.callDurationSeconds !== null
        ? `Call length: ${e.callDurationSeconds} seconds.` : "",
    ].filter(Boolean);
    return lines.join("\n");
  }
  return pkg.topicsOfInterest?.length ? `Interested in ${pkg.topicsOfInterest.join(", ")}.` : undefined;
}

/* Map a marketing event kind onto the Sales interest vocabulary. Only the
   kinds that genuinely correspond are mapped; an engagement that is not a
   request produces no signal at all, because "requested_product_info" for
   somebody who clicked a link would be a claim nobody made. */
const SIGNAL_FOR_KIND = {
  quotation_requested: "requested_quotation",
  sample_requested: "requested_sample",
  consultation_requested: "requested_meeting",
  callback_requested: "requested_meeting",
  form_submitted: "requested_product_info",
};

function interestFrom(pkg) {
  const first = (pkg.activities || []).find((a) => SIGNAL_FOR_KIND[a.kind]);
  if (!first) return { interestNote: str(pkg.assessment?.handoverReason) || undefined };
  return {
    interestSignal: SIGNAL_FOR_KIND[first.kind],
    interestNote: str(pkg.assessment?.handoverReason) || undefined,
  };
}

/** The compact marketing projection stamped onto the Prospect itself. */
function marketingBlock(handover) {
  return {
    handoverRef: handover.handoverRef,
    receivedAt: new Date(),
    campaignId: str(handover.marketing?.campaignId),
    campaignName: str(handover.marketing?.campaignName),
    assetName: str(handover.marketing?.assetName),
    sourceSystem: str(handover.marketing?.sourceSystem),
    emailConsent: str(handover.permission?.emailConsent),
    phoneConsent: str(handover.permission?.phoneConsent),
    permissionAsOf: handover.permission?.capturedAt || handover.submittedAt || new Date(),
    lastEngagedAt: handover.marketing?.lastEngagedAt || null,
    accountFit: str(handover.assessment?.accountFit),
    intent: str(handover.assessment?.intent),
    handoverReason: str(handover.assessment?.handoverReason),
    recommendedAction: str(handover.assessment?.recommendedAction),
    dataProviders: [...new Set((handover.provenance || []).map((p) => str(p.provider)).filter(Boolean))],
    ...(handover.sourceEnquiry && str(handover.sourceEnquiry.source) ? {
      sourceEnquiry: {
        source: str(handover.sourceEnquiry.source),
        sourceRef: str(handover.sourceEnquiry.sourceRef),
        kind: str(handover.sourceEnquiry.kind),
        channel: str(handover.sourceEnquiry.channel),
        submittedAt: handover.sourceEnquiry.submittedAt || undefined,
        submittedAtText: str(handover.sourceEnquiry.submittedAtText),
        submittedAtProvenance: str(handover.sourceEnquiry.submittedAtProvenance),
        submittedAtConfirmedBy: str(handover.sourceEnquiry.submittedAtConfirmedBy),
      },
    } : {}),
  };
}

/**
 * Receive one Marketing handover event.
 *
 * @param {object} event      an outbox row from the Marketing application
 * @param {object} deps.readHandover  reads the authoritative handover by ref
 * @returns {Promise<{applied:boolean, duplicate:boolean, receipt:object}>}
 */
async function receive(event, { readHandover } = {}) {
  const kind = str(event?.kind);
  if (kind !== MARKETING_EVENT_KINDS.HANDOVER_SUBMITTED) {
    /* Not a delivery failure to retry for ever — a contract this receiver does
       not implement, and saying so is more useful than a queue that never
       drains. */
    throw fail("VALIDATION", `Sales cannot receive "${kind}".`, { kind });
  }

  const companyId = event.companyId;
  const handoverRef = str(event.payload?.handoverRef);
  if (!companyId || !handoverRef) {
    throw fail("VALIDATION", "A marketing handover event needs a company and a handover reference.");
  }

  const already = await MarketingHandoverReceipt.findOne({ companyId, handoverRef }).lean();
  if (already) return { applied: false, duplicate: true, receipt: already };

  /* The AUTHORITATIVE record, read by reference. The event carried identity
     only, so there is exactly one statement of what was handed over and no
     stale copy of it travelling separately. */
  const read = readHandover || require("../marketing/prospectHandover.service").readByRef;
  const handover = await read(companyId, handoverRef);
  if (!handover) {
    throw fail("NOT_FOUND", `Handover ${handoverRef} could not be read.`, { handoverRef });
  }
  if (handover.state === "BLOCKED") {
    throw fail("VALIDATION", `Handover ${handoverRef} was blocked and must not be delivered.`, { handoverRef });
  }

  const draft = leadFromPackage(handover);

  /* ── DUPLICATE MATCHING, WITH SALES' OWN RULES ──────────────────────────
     Reused rather than reimplemented: Marketing must not carry a second
     opinion about what counts as the same person, and this service already
     answers the question for every other Prospect in the application. */
  const ctx = await createServiceContext({
    companyId,
    reason: "marketing handover duplicate check",
    legacyAware: true,
  });
  const dup = await findProspectDuplicates({ Lead, Contact, Account }, ctx, {
    company: draft.company,
    email: draft.email,
    phone: draft.phone,
    website: draft.website,
    contacts: draft.contacts || [],
  });

  /* A PERSON IDENTITY, NOT A HIGH SCORE.
     `findAccountDuplicates` rates an exact company-name match "high", and it
     is right to: for an ACCOUNT, the name is the identity. It is not the
     identity of a PERSON, and linking on it would collapse the second buyer at
     an existing customer into the first — losing them entirely, which is the
     one failure a handover must not have. So the link requires a match on
     something that means "the same person or desk": an email address, a phone
     number, a WhatsApp number. A company or domain match still travels to the
     salesperson as a candidate to look at. */
  const PERSON_IDENTITY_KINDS = new Set(["email", "phone", "whatsapp"]);
  const strong = (dup.matches || []).find((m) =>
    m.confidence === "high" && (m.matchedOn || []).some((x) => PERSON_IDENTITY_KINDS.has(x.kind)));

  const base = {
    companyId,
    handoverRef,
    sourceHandoverId: event.payload?.handoverId || handover._id || null,
    sourceEventId: event._id || null,
    correlationId: str(event.correlationId),
    receivedAt: new Date(),
    submittedAt: handover.submittedAt || null,
    package: packageSnapshot(handover),
    duplicateCandidates: dup.matches || [],
  };

  /* ── LINK ─────────────────────────────────────────────────────────────── */
  if (strong) {
    const receipt = await createReceipt({
      ...base,
      intakeOutcome: "LINKED",
      linkedRecordType: strong.recordType,
      linkedRecordId: strong.recordId,
      leadId: strong.recordType === "lead" ? strong.recordId : null,
      leadRef: strong.recordType === "lead" ? str(strong.reference) : "",
    });
    return { applied: true, duplicate: false, receipt };
  }

  /* ── CREATE ONE PROSPECT ──────────────────────────────────────────────── */
  const ownership = {
    companyId,
    companyOwnership: {
      /* Stated, not inferred. The company came from an already-authorised
         Marketing submission in this deployment, which is a different fact
         from a membership record somebody proved — so `proven` is false and
         the source says where it came from. */
      source: "MARKETING_HANDOVER",
      resolvedAt: new Date(),
      proven: false,
    },
  };

  let lead;
  try {
    lead = await createWithRef(Lead, {
      ...draft,
      ...ownership,
      marketingHandover: marketingBlock(handover),
      createdBy: { name: "Marketing handover" },
      updatedBy: { name: "Marketing handover" },
    });
  } catch (err) {
    if (err?.code === 11000 && JSON.stringify(err?.keyPattern || {}).includes("marketingHandover")) {
      /* The state guarantee caught what the event guarantee raced past. The
         Prospect exists; find it and record the receipt against it. */
      const existing = await Lead.findOne({ companyId, "marketingHandover.handoverRef": handoverRef }).lean();
      if (existing) {
        const receipt = await createReceipt({
          ...base, intakeOutcome: "CREATED", leadId: existing._id, leadRef: existing.leadId,
        });
        return { applied: false, duplicate: true, receipt };
      }
    }
    throw err;
  }

  const receipt = await createReceipt({
    ...base, intakeOutcome: "CREATED", leadId: lead._id, leadRef: lead.leadId,
  });
  return { applied: true, duplicate: false, receipt, lead: lead.toObject() };
}

/** Create the receipt, treating a lost race as the duplicate it is. */
async function createReceipt(doc) {
  try {
    const created = await MarketingHandoverReceipt.create(doc);
    return created.toObject();
  } catch (err) {
    if (err?.code === 11000) {
      return MarketingHandoverReceipt
        .findOne({ companyId: doc.companyId, handoverRef: doc.handoverRef }).lean();
    }
    throw err;
  }
}

/** What Sales stores of the handover: the package, and nothing that would make
 *  Sales responsible for keeping a Marketing fact up to date. */
function packageSnapshot(h) {
  return {
    company: h.company,
    person: h.person,
    marketing: h.marketing,
    provenance: (h.provenance || []).map((p) => ({
      provider: p.provider,
      providerRecordId: p.providerRecordId,
      retrievedAt: p.retrievedAt,
      fields: p.fields,
    })),
    permission: h.permission,
    activities: (h.activities || []).map((a) => ({
      kind: a.kind, occurredAt: a.occurredAt,
      campaignName: a.campaignName, assetName: a.assetName, detail: a.detail,
    })),
    topicsOfInterest: h.topicsOfInterest,
    sourceEnquiry: h.sourceEnquiry || null,
    assessment: h.assessment,
    matchKeys: h.matchKeys,
  };
}

module.exports = { receive, leadFromPackage, marketingBlock, leadSourceOf, HANDOVER_LEAD_SOURCE };
