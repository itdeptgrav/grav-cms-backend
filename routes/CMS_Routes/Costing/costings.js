// routes/CMS_Routes/Costing/costings.js
//
// Central Costing — Chunk 1. THE ONE CANONICAL COSTING API.
//
// Mount: /api/costings
//
// ── WHY IT IS NOT UNDER /api/cms/crm/... ────────────────────────────────────
// Sales already has costing endpoints, on the Enquiry, serving
// `Enquiry.costingSheets`. Those stay exactly as they are — this chunk
// preserves them. But a SECOND costing endpoint under Sales would say that
// costing belongs to Sales, and the whole point of the roadmap's first
// decision is that it does not: it consumes Store's supplier facts,
// Manufacturing's technical facts and Finance's overhead policy, and hands
// Sales one approved number. A neutral URL is the smallest honest way to say
// that, and it is the URL Chunks 2-8 extend.
//
// ── THE THREE RULES EVERY HANDLER HERE FOLLOWS ──────────────────────────────
// 1. COMPANY AND ACTOR COME FROM `req.costing`, NEVER FROM THE REQUEST. There
//    is no path in this file that reads `companyId` from a body, a query or a
//    header, and a body that names a different company is refused outright
//    rather than silently substituted.
// 2. SCOPE BEFORE ID. Every lookup filters by company FIRST and by `_id`
//    second, in one query — never "find by id, then check the company", which
//    is a check somebody eventually forgets to write.
// 3. NOTHING IS SERIALIZED BY HAND. Every response body comes from
//    `services/centralCosting/visibility.js`, so a restricted field cannot be
//    forgotten in one handler and remembered in another.
"use strict";

const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");

const EmployeeAuthMiddleware = require("../../../Middlewear/EmployeeAuthMiddlewear");
const {
  requireCostingContext, requireCapability, requireAnyCapability, withIdempotency,
} = require("../../../Middlewear/centralCostingContext");

const Costing = require("../../../models/CMS_Models/Costing/Costing");
const CostingVersion = require("../../../models/CMS_Models/Costing/CostingVersion");

const companyContext = require("../../../services/centralCosting/companyContext.service");
const { CAPABILITIES } = require("../../../services/centralCosting/capabilities");
const visibility = require("../../../services/centralCosting/visibility");
const { parseCreateRequest } = require("../../../services/centralCosting/costingInput");
const { createCostingWithFirstVersion } = require("../../../services/centralCosting/costingCreation.service");
const { fail, sendError, handle } = require("../../../services/storePurchase/errors");

const ENTITY = "COSTING";

router.use(EmployeeAuthMiddleware);
router.use(requireCostingContext);

/* ── THE ONE "NOT FOUND" ────────────────────────────────────────────────────
 * A costing in another company, a costing that never existed, a malformed id
 * and a draft a Sales-only reader may not know about all get THIS. Identical
 * status, identical body, no timing difference worth measuring — because a
 * 403 for a foreign id confirms the id exists, which is the disclosure the
 * tenant boundary is there to prevent. */
const notFound = () => fail("NOT_FOUND", "That costing was not found.");

/** Company first, then id — in one query. */
async function loadCosting(req) {
  const { id } = req.params;
  /* A malformed id is answered as missing rather than as a validation error:
     "that is not a valid id" and "that id is not yours" must not be
     distinguishable, or the shape of an id becomes an oracle. */
  if (!mongoose.Types.ObjectId.isValid(id)) throw notFound();

  const costing = await Costing.findOne({
    ...companyContext.companyFilter(req.costing),
    _id: new mongoose.Types.ObjectId(id),
  });
  if (!costing) throw notFound();
  return costing;
}

/** Every version of one costing, oldest first. Company-scoped independently. */
const loadVersions = (req, costing) =>
  CostingVersion.find({
    ...companyContext.companyFilter(req.costing),
    costingId: costing._id,
  })
    .sort({ versionNumber: 1 })
    .lean();

/**
 * The read gate that the capability check cannot express.
 *
 * `requireAnyCapability` answers "may this person open costings at all".
 * This answers "may they know THIS one exists" — and for a caller holding
 * only `costing.output.read`, a costing with no approved version does not.
 * See visibility.js for why that is a 404 and not a 403.
 */
function assertMayRead(req, versions) {
  if (!visibility.mayRead(req.costing, { versions })) throw notFound();
}

/* ══════════════════════════════════════════════════════════════════════════
 * CREATE
 * ═════════════════════════════════════════════════════════════════════════ */

/**
 * POST /api/costings — a costing and its version 1, or neither.
 *
 * Requires `costing.draft.write`. Idempotent on `Idempotency-Key`: the same
 * key and the same payload replays the original response rather than creating
 * a second costing, and the same key with a DIFFERENT payload is refused
 * loudly as the client bug it is.
 */
router.post(
  "/",
  requireCapability(CAPABILITIES.DRAFT_WRITE),
  withIdempotency("COSTING_CREATE"),
  handle(async (req, res) => {
    /* A payload naming another company is a client asking for something it
       must never get. Refused, not ignored: a silent substitution teaches the
       client that the field works. */
    companyContext.assertNoForeignCompany(req.costing, req.body);

    /* Allowlist by construction — see costingInput.js. Note what this cannot
       return: company, actor, status or version number. */
    const input = parseCreateRequest(req.body || {});

    const { costing, version, mode } = await createCostingWithFirstVersion(
      req.costing,
      input,
      {
        requestId: req.id || "",
        idempotencyKey: req.idempotent?.key || "",
        /* The durable marker, written with the write. */
        onCommitted: (session, created) =>
          req.idempotent?.markEffect(ENTITY, created.costing._id, session),
      },
    );

    const body = {
      success: true,
      ...visibility.serialize({ costing, versions: [version], ctx: req.costing }),
      /* Stated rather than implied: a standalone deployment gets compensated
         atomicity, not a transaction, and a client is entitled to know which
         guarantee it received. */
      atomicity: { mode, degraded: mode !== "TRANSACTIONAL" },
    };

    return req.idempotent
      ? req.idempotent.succeed(201, body, { entityType: ENTITY, entityId: costing._id })
      : res.status(201).json(body);
  }),
);

/* ══════════════════════════════════════════════════════════════════════════
 * READ
 * ═════════════════════════════════════════════════════════════════════════ */

/**
 * GET /api/costings — this company's costings.
 *
 * Included for the same reason the create needs an answer to look at: a client
 * that can create but not list has to remember ids. It carries no version
 * content at all — only the handle — so nothing confidential passes through
 * a list that a detail read would have gated.
 */
router.get(
  "/",
  requireAnyCapability(
    CAPABILITIES.COST_READ, CAPABILITIES.DRAFT_WRITE,
    CAPABILITIES.APPROVE, CAPABILITIES.MARGIN_READ, CAPABILITIES.OUTPUT_READ,
  ),
  handle(async (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 100);
    const filter = { ...companyContext.companyFilter(req.costing) };
    if (String(req.query.includeArchived || "") !== "true") filter.isArchived = false;

    const costings = await Costing.find(filter).sort({ createdAt: -1 }).limit(limit).lean();

    /* An output-only reader may not learn that drafts exist, so the same rule
       the detail route applies is applied per row here rather than left to a
       client to respect. Version status is read once for the page. */
    const internal = visibility.canSeeInternalRecord(req.costing);
    let allowed = costings;
    if (!internal) {
      const approved = await CostingVersion.find({
        ...companyContext.companyFilter(req.costing),
        costingId: { $in: costings.map((c) => c._id) },
        status: "APPROVED",
      })
        .select("costingId")
        .lean();
      const withApproved = new Set(approved.map((v) => String(v.costingId)));
      allowed = costings.filter((c) => withApproved.has(String(c._id)));
    }

    return res.json({
      success: true,
      costings: allowed.map((c) => visibility.serializeCosting(c, req.costing)),
      visibility: {
        capabilities: [...req.costing.capabilitySet].sort(),
        companyId: String(req.costing.companyId),
        membershipSource: req.costing.membershipSource,
      },
    });
  }),
);

/**
 * GET /api/costings/:id — one costing and its current version.
 */
router.get(
  "/:id",
  requireAnyCapability(
    CAPABILITIES.COST_READ, CAPABILITIES.DRAFT_WRITE,
    CAPABILITIES.APPROVE, CAPABILITIES.MARGIN_READ, CAPABILITIES.OUTPUT_READ,
  ),
  handle(async (req, res) => {
    const costing = await loadCosting(req);
    const versions = await loadVersions(req, costing);
    assertMayRead(req, versions);

    const current = versions.find((v) => String(v._id) === String(costing.currentVersionId))
      || versions[versions.length - 1]
      || null;

    return res.json({
      success: true,
      ...visibility.serialize({
        costing,
        versions: current ? [current] : [],
        ctx: req.costing,
      }),
    });
  }),
);

/**
 * GET /api/costings/:id/versions — the whole immutable history.
 *
 * Every version, oldest first, each reduced by the same visibility layer. This
 * is the endpoint that makes "a correction creates a new version" visible: a
 * corrected costing shows both, and the earlier one still reads as it did.
 */
router.get(
  "/:id/versions",
  requireAnyCapability(
    CAPABILITIES.COST_READ, CAPABILITIES.DRAFT_WRITE,
    CAPABILITIES.APPROVE, CAPABILITIES.MARGIN_READ, CAPABILITIES.OUTPUT_READ,
  ),
  handle(async (req, res) => {
    const costing = await loadCosting(req);
    const versions = await loadVersions(req, costing);
    assertMayRead(req, versions);

    return res.json({
      success: true,
      ...visibility.serialize({ costing, versions, ctx: req.costing }),
    });
  }),
);

/* ══════════════════════════════════════════════════════════════════════════
 * WHAT IS DELIBERATELY ABSENT
 *
 * There is no PUT, PATCH or DELETE on a version, and none on a costing's
 * commercial content. That is not an omission to be filled in later by
 * whoever needs it:
 *
 *   · a version's content is immutable — the model refuses a content update
 *     even if a route were added (see CostingVersion's guards), and a
 *     correction is version N+1 carrying `supersedesVersionNumber`;
 *   · a costing is archived, never deleted, because it parents frozen records
 *     a quotation or an audit may still reference. The archive transition
 *     belongs with the lifecycle Chunk 6 implements, so it is not offered here
 *     as a half-controlled write;
 *   · approval, margin policy and the calculator are Chunks 2 and 6.
 * ═════════════════════════════════════════════════════════════════════════ */

/* Any error escaping a handler above becomes a structured refusal, never a
   stack trace and never a 200 with an error body. */
router.use((err, _req, res, _next) => sendError(res, err));

module.exports = router;
