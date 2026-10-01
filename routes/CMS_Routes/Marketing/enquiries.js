// routes/CMS_Routes/Marketing/enquiries.js
//   → mounted at /api/cms/marketing
//
// THE ENQUIRIES INBOX: WHAT PEOPLE SUBMITTED, AND WHAT GRAV HAS DONE WITH IT.
//
//   GET /enquiries                  one page of this company's enquiries
//   GET /enquiries/:submissionRef   one enquiry, with what the person supplied
//
// ── READ ONLY ──────────────────────────────────────────────────────────────
// There is no route here that processes, retries, reviews, merges, hands over
// or converts an enquiry, and nothing here writes a Sales record. Marketing,
// administrators and the CEO may read; Sales is refused by the Marketing guard.
//
// ── THE COMPANY IS THE CALLER'S ────────────────────────────────────────────
// Resolved from membership. No parameter names a company, and an enquiry from
// another company answers exactly as one that does not exist.
"use strict";

const express = require("express");

const router = express.Router();

const marketingAuth = require("../../../Middlewear/MarketingAuthMiddlewear");
const membership = require("../../../services/companyContext/companyMembership.service");
const { fail } = require("../../../services/storePurchase/errors");
const providerPrivacy = require("../../../services/marketing/providerPrivacy");
const inbox = require("../../../services/marketing/leads/enquiryInbox.service");

const handle = providerPrivacy.handleMarketing({ surface: "marketing" });
const str = (v) => String(v ?? "").trim();

async function companyFor(req) {
  if (req.__marketingCompanyId) return req.__marketingCompanyId;
  const { companyId } = await membership.resolveCompanyForActor(req.user, {
    requestedCompanyId: null,
    domainLabel: "Marketing",
    fail,
  });
  req.__marketingCompanyId = companyId;
  return companyId;
}

router.use(marketingAuth);

/**
 * GET /enquiries?page=&limit=&campaign=<draftRef>&processing=&consent=&source=&kind=
 *
 * Lead-form submissions and lead-source (IndiaMART) enquiries, merged. An
 * IndiaMART row has `campaign: null`, `ingestionOrigin: "pull"`, and the fixed
 * status `not_processed` / `no_permission_recorded` / `source_does_not_ask`.
 *
 *   {
 *     "success": true,
 *     "enquiries": [{
 *       "submissionRef": "MLS-…" | "MSE-…",
 *       "receivedAt": "…", "submittedAt": "…" | null,
 *       "ingestionOrigin": "delivery" | "recovery" | "pull",
 *       "source": "google_lead_form" | "indiamart",
 *       "kind": "buyer_enquiry" | "purchased_lead" | "catalog_view" | "unclassified",
 *       "campaign": { "campaignDraftId": "<signed>" | null, "draftRef": "MCP-…", "name": "…" } | null,
 *       "contact": { "name": "…", "companyName": "…", "hasEmail": true, "hasPhone": false },
 *       "processing": "processing" | "needs_review" | "finished" | "cannot_process" | "not_processed",
 *       "consent": "unknown" | "permission_recorded" | "no_permission_recorded",
 *       "consentBasis": "<consent reason>" | null,
 *       "reviewReason": "<review reason>" | null,
 *       "states": ["lead_recorded", …]
 *     }],
 *     "page": { "number": 1, "size": 25, "total": 63, "pages": 3 },
 *     "filters": { "campaign": null, "processing": null, "consent": null, "source": null, "kind": null },
 *     "vocabulary": { … }
 *   }
 */
router.get("/enquiries", handle(async (req, res) => {
  const companyId = await companyFor(req);
  const view = await inbox.list({ companyId, query: req.query || {} });
  return res.json({
    success: true,
    enquiries: view.enquiries,
    page: view.page,
    filters: view.filters,
    vocabulary: inbox.vocabulary,
  });
}));

/**
 * GET /enquiries/:submissionRef
 *
 * The list row's fields, plus `supplied` (each contact field the person typed),
 * `answers` (with the question shown), `unmapped`, `phoneVerified` and
 * `lastProcessedAt`, and `enquiryContext` (null for a lead-form submission;
 * for IndiaMART, the source type, placeholder-name flag, the time as sent and
 * the enquiry's subject, product, category, message and call length). Takes
 * no query parameters.
 */
router.get("/enquiries/:submissionRef", handle(async (req, res) => {
  const named = Object.keys(req.query || {});
  if (named.length) {
    throw fail("VALIDATION", "An enquiry takes no parameters.", { unknown: named });
  }
  const companyId = await companyFor(req);
  const enquiry = await inbox.detail({ companyId, submissionRef: str(req.params.submissionRef) });
  return res.json({ success: true, enquiry, vocabulary: inbox.vocabulary });
}));

module.exports = router;
