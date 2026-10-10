"use strict";
/**
 * The service context for matching a customer against call, WhatsApp and
 * email evidence — `identityFor` THROWS without one, by design (see
 * serviceScope.service.js).
 *
 * routes/CMS_Routes/Sales/leads.js learned this first (its own evidenceCtx).
 * The call log, call recordings, WhatsApp and email panels still called
 * `identityFor` with no context, so every one of them answered "Sales records
 * cannot be read without a company." on every lead and customer, for every
 * user (found by scripts/pageSweep.js, 6 Oct 2026). One helper now, so the
 * next caller cannot forget.
 *
 * The company is the CALLER's, from their own session — never the record's.
 */
const { scopeFor } = require("./salesScope.service");
const { createServiceContext } = require("./serviceScope.service");

async function evidenceContext(req, reason = "call and message evidence matching") {
  const scope = await scopeFor(req);
  return createServiceContext({ companyId: scope.companyId, reason, legacyAware: true });
}

module.exports = { evidenceContext };
