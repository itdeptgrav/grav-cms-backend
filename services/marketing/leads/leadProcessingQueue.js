// services/marketing/leads/leadProcessingQueue.js
//
// THE DURABLE PROMISE THAT AN ENQUIRY WILL BE PROCESSED.
//
// ── THE GAP THIS CLOSES ────────────────────────────────────────────────────
// Chunk 3B answered Google and then started processing on the next tick. If
// the process died in between — a deploy, a restart, a crash — the enquiry was
// safely stored and nothing anywhere said its processing had not begun. It
// would have sat there, an enquiry nobody ever matched to a person, until
// somebody noticed a gap they had no reason to look for.
//
// So the promise is written down WITH the enquiry, before Google is answered:
// a receipt in `pending_identity`. A receipt that exists and is not finished is
// a durable instruction, and the recovery sweep finds every one of them.
//
// ── DELIBERATELY SMALL ─────────────────────────────────────────────────────
// It imports the receipt model and nothing else. The ingestion path needs to
// write a promise, not to be able to keep one — depending on the whole
// processor would pull identity, consent and the event ledger into the one
// code path that must answer Google quickly.
"use strict";

const {
  MarketingLeadProcessingReceipt,
} = require("../../../models/CMS_Models/Marketing/MarketingLeadProcessingReceipt");
const { CONTRACT_VERSION, REASON_CODES } = require("../../../constants/marketingLeadProcessing");

/**
 * Record that this enquiry must be processed. Idempotent.
 *
 * A second call for the same enquiry finds the receipt already there and
 * changes nothing — including a receipt that has since moved on. Enqueuing
 * never rewinds work that has started.
 *
 * @param {object}   args
 * @param {ObjectId} args.companyId
 * @param {ObjectId} args.leadId
 * @param {string}   args.submissionRef
 * @param {string}   [args.holdReason]  enqueue as waiting for a person instead
 */
async function enqueue({ companyId, leadId, submissionRef, holdReason = "" } = {}) {
  if (holdReason && !REASON_CODES.includes(holdReason)) {
    throw new Error(`Unknown hold reason: ${holdReason}`);
  }

  const selector = { companyId, leadId, contractVersion: CONTRACT_VERSION };

  return MarketingLeadProcessingReceipt.findOneAndUpdate(
    selector,
    {
      /* Only ever on insert. An existing receipt — finished, stuck or waiting
         for a person — is left exactly as it is. */
      $setOnInsert: {
        ...selector,
        submissionRef,
        stage: holdReason ? "needs_human_review" : "pending_identity",
        reason: holdReason || "",
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}

module.exports = { enqueue };
