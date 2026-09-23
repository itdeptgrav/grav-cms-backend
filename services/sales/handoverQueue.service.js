// services/sales/handoverQueue.service.js
//
// THE SALES HANDOVER INBOX AS A WORK QUEUE: WHERE EACH ONE CAME FROM, HOW
// LONG IT HAS WAITED, WHO OWNS IT, AND WHAT TO DO NEXT.
//
// ── WHY THE INBOX IS THE QUEUE ─────────────────────────────────────────────
// A handover creates a DRAFT Prospect with no owner. Drafts are visible in the
// Leads list only to their creator, their owner and Sales managers
// (routes/CMS_Routes/Sales/leads.js canSeeRestricted), so an ordinary
// salesperson never sees an unowned handover draft there. The handover inbox
// is readable and answerable by every Sales user; it is where the work is.
//
// ── NOTHING IS ASSIGNED, NOTHING IS MARKED CONTACTED ───────────────────────
// Read-only. No owner is invented: GRAV has no rule for who should own an
// incoming handover (no round robin, territory or default owner exists), so
// an awaiting handover is unowned until a salesperson accepts it for
// themselves or a Sales manager assigns it — and the queue says so.
"use strict";

const { MarketingHandoverReceipt } = require("../../models/CMS_Models/Sales/MarketingProspectIntake");
const { leadSourceOf, HANDOVER_LEAD_SOURCE } = require("./marketingProspectIntake.service");
const { LEAD_SOURCES } = require("../../constants/crm");
const { RECOMMENDED_ACTIONS, SALES_DECISIONS } = require("../../constants/marketing");
const { fail } = require("../storePurchase/errors");

const str = (v) => String(v ?? "").trim();
const labelOf = (list, code) => list.find((x) => x.code === code)?.label || code;
const minutesBetween = (from, to) => (from ? Math.max(0, Math.floor((to - new Date(from).getTime()) / 60000)) : null);

const OWNERSHIP_RULE = Object.freeze({
  automatic: false,
  means: "GRAV has no rule for who should own an incoming handover. It stays unowned until a salesperson accepts it for themselves, or a Sales manager accepts it for someone else.",
});

const NEXT_ACTIONS = Object.freeze({
  accept_or_answer: {
    code: "accept_or_answer",
    label: "Accept it to take ownership, or return, reject or link it with a reason",
    means: "Nobody owns this Prospect yet. Accepting assigns it to you; it stays a Prospect and nobody is marked as contacted.",
  },
  confirm_existing_record: {
    code: "confirm_existing_record",
    label: "Check the existing record it matched, then accept or link it as a duplicate",
    means: "Sales already had a record with the same phone or email, so no new Prospect was created.",
  },
  first_contact: {
    code: "first_contact",
    label: "Make first contact and record it",
    means: "Accepted. Nothing records that anyone has contacted the buyer yet; the owner does that on the Prospect.",
  },
});

/** Where the handover came from, in the Lead source vocabulary. */
function sourceOf(receipt) {
  const code = leadSourceOf(receipt.package || {});
  return { code, label: labelOf(LEAD_SOURCES, code) };
}

/** The queue view of one receipt. */
function queueView(receipt, nowMs = Date.now()) {
  const pkg = receipt.package || {};
  const e = pkg.sourceEnquiry && str(pkg.sourceEnquiry.source) ? pkg.sourceEnquiry : null;
  const awaiting = !receipt.decision;
  let nextAction = null;
  if (awaiting) nextAction = receipt.intakeOutcome === "LINKED" ? NEXT_ACTIONS.confirm_existing_record : NEXT_ACTIONS.accept_or_answer;
  else if (receipt.decision === "ACCEPTED") nextAction = NEXT_ACTIONS.first_contact;

  const recommended = str(pkg.assessment?.recommendedAction);
  return {
    source: sourceOf(receipt),
    sourceEnquiry: e ? {
      ref: str(e.sourceRef),
      kind: str(e.kind) || null,
      channel: str(e.channel) || null,
      /* The time as the source wrote it is always shown; `madeAt` only when
         it was read or confirmed, with which. */
      madeAt: e.submittedAt || null,
      madeAtAsSent: str(e.submittedAtText) || null,
      madeAtProvenance: str(e.submittedAtProvenance) || (e.submittedAt ? "source" : "none"),
      madeAtConfirmedBy: str(e.submittedAtConfirmedBy) || null,
    } : null,
    waitingSince: receipt.receivedAt || null,
    ageMinutes: awaiting ? minutesBetween(receipt.receivedAt, nowMs) : null,
    enquiryAgeMinutes: e?.submittedAt ? minutesBetween(e.submittedAt, nowMs) : null,
    owner: receipt.assignedTo ? { id: String(receipt.assignedTo), name: str(receipt.assignedToName) } : null,
    ownershipRule: awaiting ? OWNERSHIP_RULE : null,
    nextAction,
    suggestedFirstStep: recommended ? { code: recommended, label: labelOf(RECOMMENDED_ACTIONS, recommended) } : null,
    decision: receipt.decision ? { code: receipt.decision, label: labelOf(SALES_DECISIONS, receipt.decision), at: receipt.decidedAt || null } : null,
    prospectRef: str(receipt.leadRef) || null,
    /* Contact has not been recorded by the handover, ever. */
    contacted: false,
  };
}

const LIST_STATES = ["awaiting", "all", ...SALES_DECISIONS.map((d) => d.code)];
const LIST_SOURCES = ["indiamart", HANDOVER_LEAD_SOURCE];
const LIST_ORDERS = ["newest", "oldest"];

function sourceFilter(code) {
  if (code === "indiamart") return { "package.marketing.sourceSystem": "indiamart", "package.sourceEnquiry.source": "indiamart" };
  if (code === HANDOVER_LEAD_SOURCE) {
    return { $nor: [{ "package.marketing.sourceSystem": "indiamart", "package.sourceEnquiry.source": "indiamart" }] };
  }
  return {};
}

/** Parse and check the list query. Unrecognised values are refused. */
function parseQuery(query = {}) {
  const state = str(query.state) || "awaiting";
  const source = str(query.source) || null;
  const order = str(query.order) || "newest";
  if (!LIST_STATES.includes(state)) throw fail("VALIDATION", `state must be one of: ${LIST_STATES.join(", ")}.`, { field: "state" });
  if (source && !LIST_SOURCES.includes(source)) throw fail("VALIDATION", `source must be one of: ${LIST_SOURCES.join(", ")}.`, { field: "source" });
  if (!LIST_ORDERS.includes(order)) throw fail("VALIDATION", `order must be one of: ${LIST_ORDERS.join(", ")}.`, { field: "order" });
  return { state, source, order, limit: Math.min(Number(query.limit) || 50, 200) };
}

/** What is waiting, for the whole company: counts by source and the oldest. */
async function summary(companyId, nowMs = Date.now()) {
  const awaiting = { companyId, decision: { $exists: false } };
  const [total, indiamart, oldest] = await Promise.all([
    MarketingHandoverReceipt.countDocuments(awaiting),
    MarketingHandoverReceipt.countDocuments({ ...awaiting, ...sourceFilter("indiamart") }),
    MarketingHandoverReceipt.findOne(awaiting).sort({ receivedAt: 1 }).select("receivedAt").lean(),
  ]);
  return {
    awaiting: total,
    awaitingBySource: [
      { code: "indiamart", label: labelOf(LEAD_SOURCES, "indiamart"), count: indiamart },
      { code: HANDOVER_LEAD_SOURCE, label: labelOf(LEAD_SOURCES, HANDOVER_LEAD_SOURCE), count: total - indiamart },
    ],
    oldestWaitingSince: oldest?.receivedAt || null,
    oldestAgeMinutes: oldest ? minutesBetween(oldest.receivedAt, nowMs) : null,
    ownershipRule: OWNERSHIP_RULE,
  };
}

module.exports = { queueView, summary, parseQuery, sourceFilter, NEXT_ACTIONS, OWNERSHIP_RULE };
