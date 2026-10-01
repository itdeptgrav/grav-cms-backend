// services/marketing/leads/indiamartRouting.read.js
//
// WHAT MARKETING SEES OF INDIAMART ROUTING: WHERE EACH ENQUIRY WENT, WHETHER
// SALES HAS IT, AND WHAT SALES DECIDED.
//
// Reads Marketing's own records only — the routing ledger, the handover and
// its outbox row. It requires nothing from Sales and writes nothing. The
// writer is services/integration/indiamartSalesRouting.service.js.
//
// Never a contact detail, IndiaMART's id, a key or a Sales record id.
"use strict";

const mongoose = require("mongoose");

const { MarketingSourceEnquiryRouting } = require("../../../models/CMS_Models/Marketing/MarketingSourceEnquiryRouting");
const { MarketingOutboxEvent } = require("../../../models/CMS_Models/Marketing/MarketingEvent");
const { MarketingSourceEnquiry } = require("../../../models/CMS_Models/Marketing/MarketingSourceEnquiry");
const Handover = require("../../../models/CMS_Models/Marketing/ProspectHandover");
const { fail } = require("../../storePurchase/errors");
const { MARKETING_EVENT_KINDS } = require("../../../constants/marketing");
const I = require("../../../constants/marketingIndiamart");

const str = (v) => String(v ?? "").trim();
const R = I.ROUTING;
const holdFor = (code) => I.HOLD_REASONS.find((r) => r.code === code) || null;
/* ═══════════════════════════════════════════════════════════════════════════
   WHAT MARKETING SEES
   ═══════════════════════════════════════════════════════════════════════════ */

const view = (x) => (x ? { code: x.code, label: x.label, means: x.means } : null);
const find = (list, code) => list.find((x) => x.code === code) || null;

/** Delivery and Sales outcome for a set of routing rows, by correlation. */
async function outcomesFor(companyId, rows) {
  const corr = rows.map((r) => r.correlationId).filter(Boolean);
  const refs = rows.map((r) => r.handoverRef).filter(Boolean);
  const enquiryIds = rows.map((r) => r.enquiryId).filter(Boolean);
  const [outbox, handovers, enquiries] = await Promise.all([
    corr.length ? MarketingOutboxEvent.find({
      companyId, correlationId: { $in: corr }, kind: MARKETING_EVENT_KINDS.HANDOVER_SUBMITTED,
    }).select("correlationId status").lean() : [],
    refs.length ? Handover.find({ companyId, handoverRef: { $in: refs } }).select("handoverRef state outcome.decidedAt").lean() : [],
    enquiryIds.length ? MarketingSourceEnquiry.find({ companyId, _id: { $in: enquiryIds } }).select("submittedAt submittedAtText receivedAt").lean() : [],
  ]);
  const byEnquiry = new Map(enquiries.map((e) => [String(e._id), e]));
  const byCorr = new Map(outbox.map((o) => [o.correlationId, o.status]));
  const byRef = new Map(handovers.map((h) => [h.handoverRef, h]));
  return (row) => {
    const enquiryTime = timeOf(byEnquiry.get(String(row.enquiryId)), row);
    if (row.state !== "sent_to_sales") return { enquiryTime, delivery: null, salesOutcome: null };
    const status = byCorr.get(row.correlationId);
    const h = byRef.get(row.handoverRef);
    return {
      enquiryTime,
      delivery: view(find(I.DELIVERY_STATES, status === "DELIVERED" ? "delivered" : "pending")),
      salesOutcome: h ? {
        ...view(find(I.SALES_OUTCOMES, I.SALES_OUTCOME_BY_STATE[h.state])),
        decidedAt: h.outcome?.decidedAt || null,
      } : null,
    };
  };
}

/* The enquiry time, three ways: as IndiaMART wrote it (always), as GRAV read
   it (or null), and as a named reviewer confirmed it (or null). `provenance`
   says which one routing used; nothing here is inferred. */
function timeOf(enquiry, row) {
  const c = row.timeConfirmation || null;
  const readAs = enquiry?.submittedAt || null;
  let provenance = "none";
  if (c) provenance = "reviewer_confirmed";
  else if (readAs && row.reason !== "submitted_time_implausible") provenance = "source";
  return {
    asSent: str(enquiry?.submittedAtText) || null,
    readAs,
    confirmed: c ? { submittedAt: c.submittedAt, byName: c.by?.name || "", at: c.at, note: c.note } : null,
    provenance,
  };
}

function rowView(row, outcome) {
  const hold = row.reason ? holdFor(row.reason) : null;
  return {
    submissionRef: row.submissionRef,
    kind: row.kind,
    state: view(find(I.ROUTING_STATES, row.state)),
    reason: hold ? { ...view(hold), detail: row.reasonDetail || null, release: hold.release || null } : null,
    handoverRef: row.handoverRef || null,
    sentAt: row.sentAt || null,
    deliveredAt: row.deliveredAt || null,
    nextAttemptAt: row.state === "retrying" ? row.nextAttemptAt : null,
    attempts: row.attempts || 0,
    ...outcome(row),
    review: row.review ? {
      action: row.review.action, at: row.review.at, byName: row.review.by?.name || "", note: row.review.note || "",
    } : null,
    decidedAt: row.decidedAt || null,
  };
}

/** The routing row for one enquiry, for the inbox detail. Null if none yet. */
async function forEnquiry({ companyId, submissionRef }) {
  const company = new mongoose.Types.ObjectId(String(companyId));
  const row = await MarketingSourceEnquiryRouting.findOne({ companyId: company, submissionRef: str(submissionRef) }).lean();
  if (!row) return null;
  return rowView(row, await outcomesFor(company, [row]));
}

const LIST_PARAMS = ["state", "reason", "page", "limit"];

/** One page of routing rows, newest first, with delivery and Sales outcome. */
async function list({ companyId, query = {} }) {
  const company = new mongoose.Types.ObjectId(String(companyId));
  const unknown = Object.keys(query).filter((k) => !LIST_PARAMS.includes(k));
  if (unknown.length) throw fail("VALIDATION", `Routing accepts: ${LIST_PARAMS.join(", ")}.`, { unknown });
  const state = str(query.state);
  const reason = str(query.reason);
  if (state && !I.ROUTING_STATE_CODES.includes(state)) throw fail("VALIDATION", "Unknown routing state.", { field: "state" });
  if (reason && !I.HOLD_REASON_CODES.includes(reason)) throw fail("VALIDATION", "Unknown reason.", { field: "reason" });
  const num = (v, d, max) => {
    if (v === undefined || v === "") return d;
    const n = /^\d+$/.test(str(v)) ? Number(v) : NaN;
    if (!Number.isInteger(n) || n < 1 || (max && n > max)) throw fail("VALIDATION", "page and limit must be whole numbers in range.");
    return n;
  };
  const page = num(query.page, 1);
  const limit = num(query.limit, 25, 100);
  const match = { companyId: company, ...(state ? { state } : {}), ...(reason ? { reason } : {}) };
  const [rows, total] = await Promise.all([
    MarketingSourceEnquiryRouting.find(match).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    MarketingSourceEnquiryRouting.countDocuments(match),
  ]);
  const outcome = await outcomesFor(company, rows);
  return {
    routing: rows.map((r) => rowView(r, outcome)),
    page: { number: page, size: limit, total, pages: Math.ceil(total / limit) },
    filters: { state: state || null, reason: reason || null },
  };
}

/** Counts Marketing needs for source quality and handover outcomes. */
async function summary({ companyId }) {
  const company = new mongoose.Types.ObjectId(String(companyId));
  const [byState, byReason, sent] = await Promise.all([
    MarketingSourceEnquiryRouting.aggregate([{ $match: { companyId: company } }, { $group: { _id: "$state", n: { $sum: 1 } } }]),
    MarketingSourceEnquiryRouting.aggregate([
      { $match: { companyId: company, state: { $in: ["held_for_review", "not_routed"] } } },
      { $group: { _id: "$reason", n: { $sum: 1 } } },
    ]),
    MarketingSourceEnquiryRouting.find({ companyId: company, state: "sent_to_sales" }).select("correlationId handoverRef state").lean(),
  ]);
  const sMap = new Map(byState.map((r) => [r._id, r.n]));
  const rMap = new Map(byReason.map((r) => [r._id, r.n]));
  const outcome = await outcomesFor(company, sent);
  const salesCounts = new Map();
  let delivered = 0;
  for (const r of sent) {
    const o = outcome(r);
    if (o.delivery?.code === "delivered") delivered += 1;
    const code = o.salesOutcome?.code;
    if (code) salesCounts.set(code, (salesCounts.get(code) || 0) + 1);
  }
  return {
    byState: I.ROUTING_STATES.map((s) => ({ ...view(s), count: sMap.get(s.code) || 0 })),
    heldOrNotRoutedByReason: I.HOLD_REASONS.map((h) => ({ ...view(h), count: rMap.get(h.code) || 0 })),
    delivery: { delivered, pending: sent.length - delivered },
    salesOutcomes: I.SALES_OUTCOMES.map((o) => ({ ...view(o), count: salesCounts.get(o.code) || 0 })),
    automaticRouting: {
      routedKinds: [...R.ROUTED_KINDS],
      means: "Buyer enquiries (direct, phone and WhatsApp) go to Sales on their own through the Marketing handover. Buy-Leads and catalog views never do. Anything incomplete is held here with a reason.",
    },
    marketingPermission: {
      recorded: false,
      means: "IndiaMART never asks buyers for marketing permission. Handovers carry permission as unknown, and nothing marks anyone as agreeing to marketing.",
    },
  };
}

const vocabulary = Object.freeze({
  routingStates: I.ROUTING_STATES.map(view),
  holdReasons: I.HOLD_REASONS.map((h) => ({ ...view(h), release: h.release || null })),
  deliveryStates: I.DELIVERY_STATES.map(view),
  salesOutcomes: I.SALES_OUTCOMES.map(view),
});

module.exports = { forEnquiry, list, summary, vocabulary };
