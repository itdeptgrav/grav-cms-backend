// services/marketing/leads/leadRecovery.service.js
//
// FINISHING PROCESSING THAT STOPPED.
//
// ── THE GAP ────────────────────────────────────────────────────────────────
// GRAV answers Google and then processes. Anything can stop in between — a
// deploy, a restart, a crash — and the enquiry is then stored, safe, and never
// matched to a person. Nothing about it looks wrong until somebody asks why a
// submission has no engagement.
//
// Two things close it:
//
//   1. Ingestion writes a receipt WITH the enquiry, before Google is answered.
//      A receipt that is not finished is a durable instruction.
//   2. This sweep. It finds every unfinished receipt that nobody has touched for
//      a while, and every production enquiry that has no receipt at all — the
//      case where writing the promise itself failed — and processes them.
//
// ── SAFE TO RUN ANY NUMBER OF TIMES, FROM ANYWHERE ─────────────────────────
// Processing is idempotent by construction: every effect is fenced by a unique
// index, and a finished or held receipt is never reopened. Two sweeps racing on
// one enquiry produce one person, one engagement and one consent decision.
//
// ── COMPANY BY COMPANY ─────────────────────────────────────────────────────
// Every selector carries the company. The cross-company entry point only asks
// WHICH companies have owed work, and then sweeps each one separately.
"use strict";

const mongoose = require("mongoose");

const { MarketingAdvertisingLead } = require("../../../models/CMS_Models/Marketing/MarketingAdvertisingLead");
const { MarketingLeadProcessingReceipt } = require("../../../models/CMS_Models/Marketing/MarketingLeadProcessingReceipt");
const P = require("../../../constants/marketingLeadProcessing");
const processing = require("./leadProcessing.service");
const ingestion = require("./leadIngestion.service");

const str = (v) => String(v ?? "").trim();
const oid = (v) => new mongoose.Types.ObjectId(String(v));

/* Work that is owed. `needs_human_review` is waiting for a person, not for a
   sweep; `completed` and `refused` are finished. */
const RESUMABLE_STAGES = Object.freeze(
  P.STAGE_CODES.filter((code) => !P.TERMINAL_STAGES.includes(code)),
);

/**
 * Sweep one company.
 *
 * @param {object}   args
 * @param {ObjectId} args.companyId
 * @param {Date}     [args.now]
 * @param {number}   [args.limit]
 * @returns {Promise<{resumed:number, promised:number, completed:number, held:number, stillOwed:number, exhausted:number}>}
 */
async function sweepCompany({ companyId, now = new Date(), limit = P.RECOVERY.INTERNAL_BATCH } = {}) {
  if (!companyId) throw new Error("A recovery sweep needs a company.");
  const company = oid(companyId);
  const staleBefore = new Date(now.getTime() - P.RECOVERY.STALE_AFTER_MS);
  const result = { resumed: 0, promised: 0, completed: 0, held: 0, stillOwed: 0, exhausted: 0 };

  /* ── 1. RECEIPTS NOBODY IS WORKING ON ──────────────────────────────────
     Untouched for a while, so no live worker is mid-way through them. A
     receipt that has failed too many times is left for an operator rather
     than retried for ever; it is counted, not hidden. */
  const stale = await MarketingLeadProcessingReceipt.find({
    companyId: company,
    contractVersion: P.CONTRACT_VERSION,
    stage: { $in: RESUMABLE_STAGES },
    updatedAt: { $lt: staleBefore },
  }).select("submissionRef attempts").sort({ updatedAt: 1 }).limit(limit).lean();

  const owed = [];
  for (const r of stale) {
    if (Number(r.attempts || 0) >= P.RECOVERY.MAX_ATTEMPTS) { result.exhausted += 1; continue; }
    owed.push(r.submissionRef);
    result.resumed += 1;
  }

  /* ── 2. ENQUIRIES WITH NO PROMISE AT ALL ───────────────────────────────
     Writing the receipt failed after the enquiry was stored. Old enough
     that the ingestion writing it is certainly over. The promise is written
     now, by the same function ingestion uses — including the check for a
     probable duplicate from the other route. */
  const room = Math.max(0, limit - owed.length);
  if (room > 0) {
    const orphans = await MarketingAdvertisingLead.aggregate([
      { $match: { companyId: company, classification: "production", createdAt: { $lt: staleBefore } } },
      {
        $lookup: {
          from: MarketingLeadProcessingReceipt.collection.name,
          let: { leadId: "$_id" },
          pipeline: [
            { $match: {
              companyId: company,
              contractVersion: P.CONTRACT_VERSION,
              $expr: { $eq: ["$leadId", "$$leadId"] },
            } },
            { $project: { _id: 1 } },
            { $limit: 1 },
          ],
          as: "receipt",
        },
      },
      { $match: { receipt: { $size: 0 } } },
      { $sort: { createdAt: 1 } },
      { $limit: room },
      { $project: {
        _id: 1, companyId: 1, bindingId: 1, submissionRef: 1,
        clickId: 1, ingestionOrigin: 1, submittedAt: 1,
      } },
    ]);

    for (const lead of orphans) {
      const receipt = await ingestion.promiseProcessing(lead);
      result.promised += 1;
      if (receipt?.stage === "needs_human_review") { result.held += 1; continue; }
      owed.push(lead.submissionRef);
    }
  }

  /* ── 3. PROCESS, ONE AT A TIME ─────────────────────────────────────────
     Sequential on purpose: a sweep is catching up, not racing, and a
     failure on one enquiry is recorded on its receipt and does not stop the
     rest. */
  for (const submissionRef of owed) {
    try {
      const out = await processing.process({ companyId: company, submissionRef });
      if (out?.stage === "completed") result.completed += 1;
      else if (out?.stage === "needs_human_review") result.held += 1;
      else result.stillOwed += 1;
    } catch (err) {
      result.stillOwed += 1;
      console.error(`[lead-recovery] processing did not finish: ${str(err?.message).slice(0, 160)}`);
    }
  }

  return result;
}

/**
 * Which companies have owed work, then each one swept separately.
 *
 * Never a single cross-company update: the only cross-company question asked
 * is "who has something owed", and every write after it is scoped.
 */
async function sweepAll({ now = new Date() } = {}) {
  const staleBefore = new Date(now.getTime() - P.RECOVERY.STALE_AFTER_MS);

  const [fromReceipts, fromLeads] = await Promise.all([
    MarketingLeadProcessingReceipt.distinct("companyId", {
      contractVersion: P.CONTRACT_VERSION,
      stage: { $in: RESUMABLE_STAGES },
      updatedAt: { $lt: staleBefore },
    }),
    MarketingAdvertisingLead.distinct("companyId", {
      classification: "production", createdAt: { $lt: staleBefore },
    }),
  ]);

  const companies = [...new Set([...fromReceipts, ...fromLeads].map(String))];
  const results = [];
  for (const companyId of companies) {
    try {
      results.push(await sweepCompany({ companyId, now }));
    } catch (err) {
      console.error(`[lead-recovery] company sweep failed: ${str(err?.message).slice(0, 160)}`);
    }
  }
  return { companies: companies.length, results };
}

module.exports = { sweepCompany, sweepAll, RESUMABLE_STAGES };
