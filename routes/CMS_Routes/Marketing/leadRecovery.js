// routes/CMS_Routes/Marketing/leadRecovery.js
//   → mounted at /api/cms/marketing
//
// HAS GRAV MISSED ANY ENQUIRY, AND CAN SOMEBODY MAKE IT CHECK NOW.
//
//   GET  /lead-forms/recovery        any Marketing user
//   POST /lead-forms/recovery/run    administrator or CEO
//
// ── THE COMPANY IS THE CALLER'S, AND NOTHING ELSE IS ACCEPTED ──────────────
// Both resolve the company from the actor's membership. Neither accepts a
// query parameter or a body field: not a company, not an advertising account,
// not a campaign, not a form, not a query. The manual run reconciles the
// company's own protected bindings, exactly as the scheduler does, through the
// one reconciler — it cannot be pointed anywhere.
//
// ── WHAT COMES BACK ────────────────────────────────────────────────────────
// Coverage, times and counts in GRAV's words. Never a contact detail, a
// provider id, a database id, a binding reference, a cursor, a page token or a
// provider message.
"use strict";

const express = require("express");

const router = express.Router();

const marketingAuth = require("../../../Middlewear/MarketingAuthMiddlewear");
const membership = require("../../../services/companyContext/companyMembership.service");
const { fail } = require("../../../services/storePurchase/errors");
const providerPrivacy = require("../../../services/marketing/providerPrivacy");
const reconciliation = require("../../../services/marketing/leads/leadReconciliation.service");
const P = require("../../../constants/marketingLeadProcessing");

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

/* The same gate every Marketing administrator action uses. */
const isAdministrator = (user) => Boolean(user?.isAdmin) || ["admin", "ceo"].includes(str(user?.role));

/* ── NOTHING MAY BE NAMED ───────────────────────────────────────────────────
   Refused by name rather than ignored: a caller who sends `?campaignId=` and
   gets a 200 will believe they chose the campaign. */
function refuseInputs(req) {
  const q = Object.keys(req.query || {});
  const b = req.body && typeof req.body === "object" ? Object.keys(req.body) : [];
  const named = [...q, ...b];
  if (named.length) {
    throw fail("VALIDATION",
      "Lead-form recovery takes no parameters. It always checks this company's own lead forms.",
      { unknown: named });
  }
}

const vocabulary = () => ({
  coverageStates: P.COVERAGE_STATES.map(({ code, label, means }) => ({ code, label, means })),
  attentionReasons: P.ATTENTION_REASONS.map(({ code, label, means }) => ({ code, label, means })),
});

router.use(express.json({ limit: "1kb" }));
router.use(marketingAuth);

router.get("/lead-forms/recovery", handle(async (req, res) => {
  refuseInputs(req);
  const companyId = await companyFor(req);
  const status = await reconciliation.status({ companyId });
  return res.json({
    success: true,
    recovery: status,
    canRun: isAdministrator(req.user),
    vocabulary: vocabulary(),
  });
}));

router.post("/lead-forms/recovery/run", handle(async (req, res) => {
  if (!isAdministrator(req.user)) {
    throw fail("FORBIDDEN",
      "Checking the advertising channel for missed enquiries is an administrator action. You can still view recovery status.");
  }
  refuseInputs(req);
  const companyId = await companyFor(req);

  const out = await reconciliation.reconcileCompany({ companyId, startedBy: "manual" });
  return res.status(out.busy ? 409 : 200).json({
    success: !out.busy,
    /* Already running is a real answer, not an error to retry into. */
    alreadyRunning: Boolean(out.busy),
    leadFormsChecked: out.bindings,
    counts: {
      read: out.counts.read,
      recorded: out.counts.recorded,
      duplicatesIgnored: out.counts.alreadyHeld,
      heldForReview: out.counts.heldForReview,
      unreadable: out.counts.unreadable,
    },
    recovery: out.status,
    vocabulary: vocabulary(),
  });
}));

module.exports = router;
module.exports.isAdministrator = isAdministrator;
