// routes/CMS_Routes/Merchandising/merchandisingWorkRoute.js
//
// MERCHANDISING — THE APP'S OWN READ DOOR.
//
// ── WHY THIS IS NOT ON THE SAMPLE-STYLE ROUTER ──────────────────────────────
// `routes/CMS_Routes/Sales/sampleStyles.js` is behind `salesAuth` and carries
// the whole technical record: materials, requirements, evidence, the sample
// lifecycle, the two approval gates. The Merchandising style reads that live
// there today inherit its BROAD Sales CRM role allowlist, which means a
// merchandiser needs a Sales seat to open their own dashboard, and anybody
// holding a Sales seat can read this queue.
//
// This is a narrow door instead. It is gated on a live `merchandiser`
// department grant, it can express nothing but reads, and it does not widen
// the Sales allowlist by a single role. The existing style WRITE endpoints are
// deliberately left where they are — moving them is its own chunk, with its
// own migration and its own tests.
//
// ── THE RULE IS NOT WRITTEN HERE ────────────────────────────────────────────
// It used to be. This file carried its own `requireMerchandising` — its own
// grant read, its own ladder comparison, its own refusal shape, and its own
// `isAdmin` bypass, which is exactly where that bypass would have outlived its
// removal elsewhere. One policy written twice is one place to fix and one
// place to forget. The rule now lives in
// `services/merchandising/access.service.js` and this router asks for it.
//
// ── AND NO JOURNEY IS PUBLISHED ─────────────────────────────────────────────
// Merchandising works from a Style and has no Sales Journey workspace. Company
// ownership is proved through the Sales parents, because that is where a
// SampleStyle's company lives, but no journey id, enquiry id, enquiry
// reference or customer name is in any response here — and no aggregation or
// response shaping happens in this file, which is what keeps that a property
// of one reviewed service rather than of every handler somebody adds later.
"use strict";

const express = require("express");

const EmployeeAuthMiddleware = require("../../../Middlewear/EmployeeAuthMiddlewear");
const { fail, sendError, handle } = require("../../../services/storePurchase/errors");
const {
  CAPABILITY, merchandisingCapability,
} = require("../../../services/merchandising/access.service");
const {
  merchandisingCompanyMiddleware,
} = require("../../../services/companyContext/merchandisingScope.service");
const styleWork = require("../../../services/merchandising/styleWork.service");
const packagingItems = require("../../../services/merchandising/packagingItems.service");

const router = express.Router();
router.use(EmployeeAuthMiddleware);

/* The acting company, from the ONE shared middleware — the same resolution
   the Execution router uses, so the two cannot drift. */
const requireCompany = merchandisingCompanyMiddleware({ domainLabel: "Merchandising" });

/**
 * A live Merchandising seat, from the one implementation of that rule.
 *
 * Reading is open to a VIEWER and above, because a merchandiser who cannot see
 * their own queue has no reason to be here; the editor, approver and owner
 * levels decide what may be CHANGED, and nothing on this router changes
 * anything.
 *
 * ── NOBODY IS ADMITTED WITHOUT ONE ──────────────────────────────────────────
 * A Sales, R&D, Store or Project-Manager seat reaches nothing here — those
 * departments have their own doors onto their own half of a style, and none of
 * them has Merchandising's queue. Neither does a platform administrator: see
 * the access service for why `isAdmin` stopped being a rung on this ladder.
 */
const canRead = merchandisingCapability(CAPABILITY.FILE_READ);

/**
 * GET /overview — the factual, style-level counts behind the Overview page.
 *
 * Every number here has a queue behind it: the same conditions, the same
 * bound, the same company. Nothing is a trend, a percentage, a deadline or a
 * risk, because no record holds one yet.
 */
router.get("/overview", requireCompany, canRead, handle(async (req, res) => {
  const out = await styleWork.overview(req.merchandising);
  return res.json({ success: true, ...out });
}));

/**
 * GET /work?q=&kind=&limit=&cursor= — one row per style with something open.
 *
 * The search, the filter, the sort and the page all happen in the database.
 * `kinds` comes back with every response so a screen can render its filter
 * from the contract rather than from a list it keeps in step by hand.
 */
/**
 * GET /styles/:styleId/packaging-items?q= — the components a merchandiser may
 * choose from, for one style.
 *
 * Merchandising's own door onto the company item master, rather than the R&D
 * raw-item search the picker used to borrow. Same grant, same company, same
 * missing-and-foreign answer as every other style read — and three fields
 * back, none of them a price, a supplier or a stock position. See the service
 * for what that endpoint was publishing and why it could not simply be gated.
 */
router.get("/styles/:styleId/packaging-items", requireCompany, canRead, handle(async (req, res) => {
  const out = await packagingItems.searchPackagingItems(req.merchandising, {
    styleId: req.params.styleId,
    q: req.query.q,
  });
  return res.json({ success: true, ...out });
}));

router.get("/work", requireCompany, canRead, handle(async (req, res) => {
  const out = await styleWork.work(req.merchandising, {
    q: req.query.q,
    kind: req.query.kind,
    limit: req.query.limit,
    cursor: req.query.cursor,
  });
  return res.json({ success: true, ...out });
}));

module.exports = router;
