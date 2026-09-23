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
const enquiryLookup = require("../../../services/centralCosting/enquiryLookup.service");
const CostingVersion = require("../../../models/CMS_Models/Costing/CostingVersion");

const companyContext = require("../../../services/centralCosting/companyContext.service");
const capabilityService = require("../../../services/centralCosting/capabilities");
const { CAPABILITIES } = capabilityService;
const visibility = require("../../../services/centralCosting/visibility");
const { parseCreateRequest } = require("../../../services/centralCosting/costingInput");
const {
  createCostingWithFirstVersion, findByCreationClaim,
} = require("../../../services/centralCosting/costingCreation.service");
const { resolveContext } = require("../../../services/centralCosting/contextResolver.service");
const { parseCalculationRequest, parseScenarios } = require("../../../services/centralCosting/calculationInput");
/* What Sales asked to be costed. Read-only: this file cannot write a brief,
   and no request can supply one. */
const salesBrief = require("../../../services/centralCosting/salesBrief.service");
const versionCreation = require("../../../services/centralCosting/versionCreation.service");
const legacyImport = require("../../../services/centralCosting/legacyImport.service");
const policyService = require("../../../services/centralCosting/policy.service");
const lifecycle = require("../../../services/centralCosting/lifecycle.service");
const offerRead = require("../../../services/storePurchase/supplierOfferRead.service");
const offerPricing = require("../../../services/centralCosting/offerPricing.service");
const technicalSource = require("../../../services/centralCosting/technicalSource.service");
const technicalPreview = require("../../../services/centralCosting/technicalPreview.service");
const approvedOutput = require("../../../services/centralCosting/approvedOutput.service");
const procurementProjection = require("../../../services/centralCosting/procurementProjection.service");
const projectionHandoff = require("../../../services/centralCosting/projectionHandoff.service");
const actualProcurement = require("../../../services/centralCosting/actualProcurement.service");
const productionActual = require("../../../services/centralCosting/productionActual.service");
const assembly = require("../../../services/centralCosting/assembly.service");
const { fail, sendError, handle } = require("../../../services/storePurchase/errors");

const ENTITY = "COSTING";

/** What an idempotency key on a per-costing route is bound to. From the URL. */
const versionTarget = (req) => `costing:${req.params.id}`;

/* Shared with the legacy import, which has to answer exactly the same
   question — see versionCreation.service.js. */
const { claimMismatch } = versionCreation;

router.use(EmployeeAuthMiddleware);

/**
 * GET /api/costings/access — does this person hold ANY costing capability?
 *
 * ── WHY IT SITS ABOVE THE COMPANY CONTEXT ───────────────────────────────────
 * The Apps switcher asks this to decide whether to show a Costing tile, and it
 * asks on pages that have nothing to do with costing. Requiring the company
 * context would answer `COMPANY_SELECTION_REQUIRED` for anybody in two
 * companies — so the tile would vanish for exactly the people most likely to
 * need it, for a reason that has nothing to do with their permissions.
 *
 * Capabilities are company-INDEPENDENT: `resolveCapabilities` reads the
 * person's own grants and admin status, not a membership. So this question can
 * be answered honestly before a company is chosen, and the company is still
 * resolved — and still fails closed — on every route below.
 *
 * ── AND IT GRANTS NOTHING ───────────────────────────────────────────────────
 * It returns the capability names this account already has and no data of any
 * kind. Hiding a tile is not protection and is not treated as any: every
 * endpoint below re-checks the same capabilities server-side, so somebody who
 * types the URL reaches the app and is told what they may do there.
 */
router.get("/access", handle(async (req, res) => {
  const { capabilities } = await capabilityService.resolveCapabilities({
    email: req.user?.email,
    employeeRef: req.user?.id,
    biometricId: req.user?.employeeId,
  });
  const list = [...(capabilities || [])].sort();
  return res.json({ success: true, hasAccess: list.length > 0, capabilities: list });
}));

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

/**
 * Which versions this reader may be shown — Chunk 6A.
 *
 * ── THE HOLE THIS CLOSES ────────────────────────────────────────────────────
 * Both read routes handed an output-only reader whatever they had: the detail
 * route the CURRENT version, the history route ALL of them. That was harmless
 * only because nothing could ever be approved, so `mayRead` refused every
 * output-only caller before either line ran. The moment approval exists the
 * paths become reachable, and they are wrong in both directions at once:
 *
 *   · Sales is shown the newest DRAFT — a number nobody approved, and the
 *     existence of work in progress they have no business knowing about;
 *   · Sales is NOT shown the approved version, which is the one thing they
 *     are entitled to.
 *
 * So the approved version is resolved explicitly. `approvedVersionId` is the
 * authority; the status scan is the fallback for a costing approved before
 * the pointer existed.
 */
function visibleVersions(req, costing, versions) {
  if (visibility.canSeeInternalRecord(req.costing)) return versions;
  const approved = versions.find((v) => String(v._id) === String(costing.approvedVersionId))
    || versions.find((v) => v.status === "APPROVED")
    || null;
  /* One version or none. Never a draft, and never a count that would say how
     many drafts there are. */
  return approved ? [approved] : [];
}

/* ══ A COSTING BELONGS TO A REAL ENQUIRY PRODUCT ═════════════════════════════
 *
 * ── WHY ADHOC IS CLOSED ─────────────────────────────────────────────────────
 * It was the escape hatch: raise a costing that references nothing, type every
 * line by hand, and approve it. Everything this domain has been built to
 * guarantee — that a consumption came from R&D's sample, that a rate came from
 * a dated supplier quotation, that labour was costed on the company's own
 * productivity assumptions — is optional the moment that route exists, because
 * the same person can produce an approvable number without any of it.
 *
 * And nothing on the resulting version says so. An approved ADHOC costing and
 * an approved source-backed one are the same shape, so Sales cannot tell a
 * quotation built from records from one built from somebody's recollection.
 *
 * ── WHAT HAPPENS TO THE ONES THAT EXIST ─────────────────────────────────────
 * They stay readable, unchanged, forever. They are history and deleting them
 * would be worse than the hole they represent. What they cannot do is move:
 * no new version, no submission, no approval, no price to Sales. A costing
 * that could not be built today should not be able to become current today.
 *
 * `PRELIMINARY_ESTIMATE` — a governed, deliberately non-approvable way to cost
 * something before an enquiry exists — is a separate piece of work and is not
 * being smuggled in here.
 */
const HISTORICAL_MANUAL = "Historical manual costing";

function refuseHistoricalManual(costing, action) {
  if (costing?.context?.type !== "ADHOC") return;
  throw fail("COSTING_ADHOC_READ_ONLY",
    `${HISTORICAL_MANUAL}. It stays readable as a record, but it cannot ${action}: its inputs were typed rather than read from the technical record, the quotation register and the company policy.`,
    {
      reason: "ADHOC_READ_ONLY",
      contextType: "ADHOC",
      label: HISTORICAL_MANUAL,
      /* Where the work goes instead. */
      remedy: "Raise the costing against the enquiry product it is for.",
    });
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

    /* ── NO NEW MANUAL COSTINGS ──────────────────────────────────────────
       Refused server-side, not merely absent from the screen: hiding a button
       is not a rule, and this endpoint is reachable by anything holding
       `costing.draft.write`. */
    if (String(req.body?.context?.type || "").toUpperCase() === "ADHOC") {
      throw fail("COSTING_ADHOC_CREATION_CLOSED",
        "A costing is raised against the enquiry product it is for, so its materials, operations and rates come from the technical record, the supplier quotations and the company policy rather than being typed.",
        {
          reason: "ADHOC_CREATION_CLOSED",
          allowed: ["ENQUIRY_STYLE"],
          remedy: "Choose the enquiry product this costing is for.",
        });
    }

    /* ── RECOVER BEFORE CREATING, ALWAYS ────────────────────────────────
     * Not only when the idempotency record says the effect landed. The record
     * is a second write and can fail; the claim on the costing cannot,
     * because it was written in the same insert. So the first question this
     * handler asks is "did this exact user action already produce a costing",
     * and it asks the costings collection, not the bookkeeping. */
    const recovered = await recoverExistingCreation(req, res);
    if (recovered) return recovered;

    /* Allowlist by construction — see costingInput.js. Note what this cannot
       return: company, actor, status or version number.
       Called with ONE argument: there is no request value that can set
       `trusted`, which is what keeps `VERIFIED` provenance out of reach of a
       payload. */
    const input = parseCreateRequest(req.body || {});

    /* ── THE REFERENCE IS PROVED AFTER THE COMPANY, NEVER BEFORE ─────────
     * `req.costing.companyId` is already resolved from the actor's own
     * membership by the time this runs. The enquiry is then looked up within
     * that company and its display snapshot is built from the document — the
     * reference never contributes to which company the actor belongs to. */
    const { contextSnapshot } = await resolveContext(req.costing, input.context, input.contextSnapshot);

    /* ── ONE LIVE COSTING PER ENQUIRY PRODUCT ────────────────────────────
     * Distinct from the idempotency claim above, which catches a RETRY of one
     * user action. This catches a second, deliberate action against work that
     * is already under way — two people costing the same product on Tuesday
     * and Thursday, or one person who opened the picker twice.
     *
     * Two live costings for one enquiry product is not a harmless duplicate:
     * they diverge, both get quoted, and nobody can say afterwards which one
     * Sales used. So the existing one is HANDED BACK rather than a second
     * created, with a code the screen can turn into "this is already being
     * costed — open it".
     *
     * Archived costings do not count: re-costing a product whose earlier
     * costing was put away is ordinary work, and refusing it would leave no
     * way to start again. */
    if (input.context?.type === "ENQUIRY_STYLE") {
      const live = await Costing.findOne({
        ...companyContext.companyFilter(req.costing),
        isArchived: false,
        "context.type": "ENQUIRY_STYLE",
        "context.primaryId": input.context.primaryId,
        "context.externalKey": input.context.externalKey,
      }).lean();
      if (live) {
        const versions = await CostingVersion.find({
          ...companyContext.companyFilter(req.costing),
          costingId: live._id,
        }).sort({ versionNumber: 1 }).lean();
        return res.status(409).json({
          success: false,
          error: {
            code: "COSTING_ALREADY_EXISTS",
            message: "This enquiry product is already being costed. Open the existing costing instead of starting a second one.",
            details: { costingId: String(live._id), status: live.status },
          },
          /* The costing itself, through the ordinary visibility boundary — so
             the screen can route the person straight there without a second
             request, and an output-only reader still sees only what they may. */
          ...visibility.serialize({ costing: live, versions, ctx: req.costing }),
        });
      }
    }

    let created;
    try {
      created = await createCostingWithFirstVersion(
        req.costing,
        { ...input, contextSnapshot },
        {
          requestId: req.id || "",
          idempotencyKey: req.idempotent?.key || "",
          claim: req.idempotent
            ? { claimId: req.idempotent.claimId, requestHash: req.idempotent.requestHash }
            : null,
          /* Belt to the claim's braces: still written, still immediately, but
             no longer the thing that prevents a duplicate. */
          onCommitted: (session, made) =>
            req.idempotent?.markEffect(ENTITY, made.costing._id, session),
        },
      );
    } catch (err) {
      /* A concurrent request with the same key won the claim index. Hand back
         what it created rather than reporting a failure for work that
         succeeded. */
      if (err?.name === "CostingClaimAlreadyUsed") {
        const late = await recoverExistingCreation(req, res);
        if (late) return late;
      }
      throw err;
    }

    const { costing, version, mode } = created;
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

/**
 * The costing this exact user action already created, if it did.
 *
 * Returns a sent response, or `null` to mean "carry on and create it".
 *
 * ── WHY THE PAYLOAD IS RE-CHECKED HERE ──────────────────────────────────────
 * `begin()` already refuses a key reused for a different payload — while its
 * record lives. That record expires after thirty days; the costing does not.
 * Without this comparison, a key reused a year later for something completely
 * different would be handed back the old costing and told it had succeeded.
 * So the costing carries the body fingerprint too, and the same key with a
 * different payload stays a conflict for as long as the costing exists.
 */
async function recoverExistingCreation(req, res) {
  if (!req.idempotent?.claimId) return null;

  const existing = await findByCreationClaim(req.costing, req.idempotent.claimId);
  if (!existing) return null;

  if ((existing.creationRequestHash || "") !== (req.idempotent.requestHash || "")) {
    throw fail(
      "IDEMPOTENCY_KEY_REUSED",
      "This request key was already used for a different request. Start the action again.",
      { operation: "COSTING_CREATE" },
    );
  }

  const versions = await loadVersions(req, existing);
  const body = {
    success: true,
    ...visibility.serialize({ costing: existing, versions, ctx: req.costing }),
    /* Said plainly: this response describes work that had ALREADY happened on
       an earlier attempt whose answer never reached the caller. */
    recovered: true,
  };
  res.set("Idempotency-Recovered", "true");

  /* Settle the record so the NEXT retry is a plain replay rather than another
     recovery lookup. */
  return req.idempotent.succeed(200, body, { entityType: ENTITY, entityId: existing._id });
}

/* ── DECLARED BEFORE `/:id`, DELIBERATELY ───────────────────────────────────
 * Express matches in declaration order, so a static path that lives under the
 * same prefix as a parameter route must come first. Declared after `/:id`,
 * `GET /policy/current` is answered as a lookup for a costing whose id is
 * "policy" — a 404 that looks like a missing record rather than a shadowed
 * route, which is exactly how this bug survives review. The same mistake is
 * documented in routes/.../Configurations/warehouses.js, where it shipped.
 * ═════════════════════════════════════════════════════════════════════════ */

/* ══════════════════════════════════════════════════════════════════════════
 * COMPANY COSTING POLICY
 *
 * Mounted here rather than in Sales, and that is roadmap decision 2 rather
 * than a filing preference: a minimum margin kept inside the Sales app is a
 * minimum margin the people negotiating against it can change, which is not a
 * floor. Reading it needs a costing capability; changing it needs
 * `costing.policy.manage` and nothing less.
 * ═════════════════════════════════════════════════════════════════════════ */

/** The company's rules, and whether anybody has actually set them. */
router.get(
  "/policy/current",
  requireAnyCapability(
    CAPABILITIES.COST_READ, CAPABILITIES.DRAFT_WRITE, CAPABILITIES.APPROVE,
    CAPABILITIES.MARGIN_READ, CAPABILITIES.POLICY_MANAGE,
  ),
  handle(async (req, res) => {
    /* `contingency` is the Board's resolved DECISION, carried so this screen
       can tell "the Board decided none" from "nobody has decided" — the two
       the retired single rate could not distinguish. */
    const { policy, configured, contingency, margin } = await policyService.getPolicy(req.costing);
    const canSeeMargin = req.costing.capabilitySet.has(CAPABILITIES.MARGIN_READ)
      || req.costing.capabilitySet.has(CAPABILITIES.POLICY_MANAGE);

    /* ── THE MARGIN BAND IS MARGIN DATA ────────────────────────────────
       Even here. Somebody who may read the cost build-up has no automatic
       business knowing what the company adds on top of it, and the policy
       screen is not a way around the block gate on a version. */
    const body = {
      baseCurrency: policy.baseCurrency,
      roundingMode: policy.roundingMode,
      sellingPriceIncrementMinor: policy.sellingPriceIncrementMinor,
      /* ── OVERHEAD IS HERE TO BE READ, NOT SET ─────────────────────────
         What the company adds to cover what it costs to run moved to the
         Board, where it has an approver and a date it takes effect. These are
         the LEGACY values still on this company's record — shown so a company
         can see what it is carrying and approve the same number deliberately,
         and so versions frozen under the old rule stay explicable.

         They are not what a costing uses any more. `savePolicy` refuses to
         write them, and `overheadPolicy` below says so, so the screen states
         it rather than offering a field the server will reject. */
      overheadBasis: policy.legacyOverheadBasis ?? null,
      overheadRatePercent: policy.legacyOverheadRatePercent ?? null,
      overheadPolicy: {
        editable: false,
        ownedBy: "BOARD",
        policyKey: "OVERHEAD",
        legacyRatePresent: policy.legacyOverheadRatePercent !== undefined
          && policy.legacyOverheadRatePercent !== null && policy.legacyOverheadRatePercent !== "",
        /* Whether the Board has actually decided — so the screen can tell
           "you still hold an old rate that no longer applies" from "the Board
           has approved one and this is history". */
        boardPolicyInForce: policy.overheadRatePercent !== undefined
          && policy.overheadRatePercent !== null && policy.overheadRatePercent !== "",
        note: "Company and factory overhead is a Board decision, approved and effective from a date. "
          + "It is no longer set here, and a rate left on this record is not applied to any costing.",
      },
      /* ── THE REST OF THE COST RULES, WHICH USED TO BE UNREADABLE HERE ───
         Financing, contingency and the four production assumptions were
         stored, snapshotted onto every version and used by the engine, and
         this response never mentioned them — so a policy screen could not
         show what the company had set, let alone edit it. They are cost
         rules, not margin, and sit with overhead. Null when unset: an absent
         rule is not a rate of zero. */
      /* ── FINANCING IS HERE TO BE READ, NOT SET ────────────────────────
         The cost of money moved to the Board, where it has a methodology, an
         effective date and an approver. These two fields stay readable so a
         company that still holds the old flat rate can see it and retire it,
         and so versions frozen under it stay explicable. `savePolicy` refuses
         to write them; `financingPolicy` below says so, so the screen states
         it rather than offering a field the server will reject. */
      financingBasis: policy.financingBasis ?? null,
      financingRatePercent: policy.financingRatePercent ?? null,
      financingPolicy: {
        editable: false,
        ownedBy: "BOARD",
        policyKey: "FINANCING",
        legacyRatePresent: policy.financingRatePercent !== undefined
          && policy.financingRatePercent !== null && policy.financingRatePercent !== "",
        note: "The cost of financing is a Board decision. It is calculated from the Board's approved "
          + "methodology and the payment terms Sales confirms on each order, not from a rate set here.",
      },
      /* ── CONTINGENCY IS HERE TO BE READ, NOT SET ──────────────────────
         Whether the company adds a standard cushion to what it quotes moved to
         the Board, where the decision has a mode, an approver and a date it
         takes effect — and where deciding NOT to add one is recorded as
         explicitly as deciding to.

         These are the LEGACY values still on this company's record — shown so
         a company can see what it is carrying and approve the same rule
         deliberately, and so versions frozen under them stay explicable.

         They are not what a costing uses any more. `savePolicy` refuses to
         write them, and `contingencyPolicy` below says so. */
      contingencyBasis: policy.legacyContingencyBasis ?? null,
      contingencyRatePercent: policy.legacyContingencyRatePercent ?? null,
      contingencyPolicy: {
        editable: false,
        ownedBy: "BOARD",
        policyKey: "CONTINGENCY_POLICY",
        legacyValuesPresent: [policy.legacyContingencyBasis, policy.legacyContingencyRatePercent]
          .some((v) => v !== undefined && v !== null && v !== ""),
        /* Whether the Board has actually decided — and a decision of NONE
           counts, which is why this reads the resolved state rather than
           testing whether a rate is filled in. A company that decided it adds
           no contingency has a policy in force; it just has no rate. */
        boardPolicyInForce: Boolean(contingency && contingency.state !== "POLICY_MISSING"),
        boardDecision: contingency?.mode || null,
        note: "Whether this company adds a standard contingency, and on what subtotal, is a Board "
          + "decision, approved and effective from a date. It is no longer set here, and a rate left "
          + "on this record is not applied to any costing.",
      },
      /* ── INPUT GST IS HERE TO BE READ, NOT SET ────────────────────────
         Whether eligible input tax is reclaimed or becomes product cost moved
         to the Board, where it has an approver and a date it takes effect.
         This is the LEGACY value still on this company's record — shown so a
         company can see what it is carrying and approve the same treatment
         deliberately, and so versions frozen under it stay explicable.

         It is not what a costing uses any more. `savePolicy` refuses to write
         it, and `gstPolicy` below says so. */
      inputGstTreatment: policy.legacyInputGstTreatment ?? null,
      gstPolicy: {
        editable: false,
        ownedBy: "BOARD",
        policyKey: "GST_TAX_POLICY",
        legacyValuePresent: policy.legacyInputGstTreatment !== undefined
          && policy.legacyInputGstTreatment !== null && policy.legacyInputGstTreatment !== "",
        boardPolicyInForce: policy.inputGstTreatment !== undefined
          && policy.inputGstTreatment !== null && policy.inputGstTreatment !== "",
        note: "Whether eligible input GST is reclaimed or included in product cost is a Board decision, "
          + "approved and effective from a date. A quotation that is not taxable at all still says so "
          + "itself, and that continues to take precedence.",
      },
      /* ── LABOUR IS HERE TO BE READ, NOT SET ───────────────────────────
         How much of a paid month is productive, what an operator costs beyond
         take-home pay and where machine cost sits moved to the Board, where
         they have an approver and a date they take effect. These are the
         LEGACY values still on this company's record — shown so a company can
         see what it is carrying and approve the same assumptions
         deliberately, and so versions frozen under them stay explicable.

         They are not what a costing uses any more. `savePolicy` refuses to
         write them, and `labourPolicy` below says so, so the screen states it
         rather than offering fields the server will reject. */
      productiveMinutesPerMonth: policy.legacyProductiveMinutesPerMonth ?? null,
      labourEfficiencyPercent: policy.legacyLabourEfficiencyPercent ?? null,
      employerBurdenPercent: policy.legacyEmployerBurdenPercent ?? null,
      machineBurdenTreatment: policy.legacyMachineBurdenTreatment ?? null,
      labourPolicy: {
        editable: false,
        ownedBy: "BOARD",
        policyKey: "LABOUR_METHODOLOGY",
        legacyValuesPresent: [
          policy.legacyProductiveMinutesPerMonth, policy.legacyLabourEfficiencyPercent,
          policy.legacyEmployerBurdenPercent, policy.legacyMachineBurdenTreatment,
        ].some((v) => v !== undefined && v !== null && v !== ""),
        /* Whether the Board has actually decided — so the screen can tell "you
           still hold old assumptions that no longer apply" from "the Board has
           approved a methodology and this is history". */
        boardPolicyInForce: policy.employerBurdenPercent !== undefined
          && policy.employerBurdenPercent !== null && policy.employerBurdenPercent !== "",
        note: "The labour costing methodology is a Board decision, approved and effective from a date. "
          + "It is no longer set here, and assumptions left on this record are not applied to any costing.",
      },
      /* ── DEVELOPMENT CHARGES ARE HERE TO BE READ, NOT SET ─────────────
         What the company charges for development and tooling work it does
         itself moved to the Board, where each charge has an approver and a
         date it takes effect. This is the LEGACY table still on this
         company's record — shown so a company can see what it is carrying and
         so the Board can approve the same charges deliberately, and so
         versions frozen under it stay explicable.

         It is not what a costing uses any more. `savePolicy` refuses to write
         it, and `developmentPolicy` below says so, so the screen states it
         rather than offering an editor the server will reject. */
      developmentCharges: policy.legacyDevelopmentCharges || [],
      developmentPolicy: {
        editable: false,
        ownedBy: "BOARD",
        policyKey: "DEVELOPMENT_CHARGE_POLICY",
        legacyChargeCount: (policy.legacyDevelopmentCharges || []).length,
        /* Whether the Board has actually decided — so the screen can tell
           "you still hold old charges that no longer apply" from "the Board
           has approved a catalogue and this is history". A catalogue the
           Board deliberately approved EMPTY still counts as in force, which
           is why this tests for the array rather than its length. */
        boardPolicyInForce: Array.isArray(policy.developmentCharges),
        note: "Development and tooling charges are a Board decision, approved and effective from a "
          + "date. They are no longer set here, and charges left on this record are not applied to "
          + "any costing. Setup bought from a supplier is still priced from that supplier's "
          + "quotation and is unaffected.",
      },
      revision: policy.revision,
    };
    if (canSeeMargin) {
      /* -- THE MARGIN BAND IS HERE TO BE READ, NOT SET ------------------
         What the company is prepared to sell for moved to the Board, where the
         decision has an approver and a date it takes effect. These are the
         LEGACY values still on this company's record - shown so a company can
         see what it is carrying and approve the same band deliberately, and so
         versions frozen under them stay explicable.

         They are not what a costing prices from any more. `savePolicy` refuses
         to write them, and `marginPolicy` below says so.

         Still behind the same margin grant: what the company is prepared to
         sell for is commercial information whether or not it is in force. */
      body.minimumMarginPercent = policy.legacyMinimumMarginPercent ?? null;
      body.targetMarginPercent = policy.legacyTargetMarginPercent ?? null;
      body.preferredMarginPercent = policy.legacyPreferredMarginPercent ?? null;
      body.approvalThresholdMarginPercent = policy.legacyApprovalThresholdMarginPercent ?? null;
      /* ── A PROFIT ASSUMPTION, GATED WITH THE OTHER PROFIT FIGURES ──────
         What a price leaves after income tax is commercial information, so
         it sits behind the same margin grant as the band it is read beside.
         Null, never 0 — "no rate is set" and "the rate is nil" are
         different answers, and only one of them is a decision. */
      body.estimatedIncomeTaxRatePercent = policy.legacyEstimatedIncomeTaxRatePercent ?? null;
      body.marginPolicy = {
        editable: false,
        ownedBy: "BOARD",
        policyKey: "MARGIN_POLICY",
        legacyValuesPresent: [
          policy.legacyMinimumMarginPercent, policy.legacyTargetMarginPercent,
          policy.legacyPreferredMarginPercent,
        ].some((v) => v !== undefined && v !== null && v !== ""),
        boardPolicyInForce: Boolean(margin && margin.state === "APPLIED"),
        /* Said plainly, because this is the only retired family whose absence
           stops a costing rather than leaving a gap in one. */
        pricingBlockedWithout: true,
        note: "The margin band is a Board decision, approved and effective from a date. It is no "
          + "longer set here, and a band left on this record is not used to price anything. Until "
          + "the Board approves one, no selling price can be calculated.",
      };
    }

    return res.json({
      success: true,
      policy: body,
      /* The version the editor is composing against. A write must send it
         back, and a write that sends a stale one is refused rather than
         allowed to overwrite somebody else's change. */
      revision: policy.revision,
      /* Said plainly, so a screen can show "not set up yet" instead of
         presenting a zero margin as somebody's decision. */
      configured,
      canManage: req.costing.capabilitySet.has(CAPABILITIES.POLICY_MANAGE),
      visibility: {
        withheld: canSeeMargin ? [] : ["marginBand"],
        capabilities: [...req.costing.capabilitySet].sort(),
        companyId: String(req.costing.companyId),
      },
    });
  }),
);

/** Change it. Company comes from context; the body carries only the rules. */
router.put(
  "/policy/current",
  requireCapability(CAPABILITIES.POLICY_MANAGE),
  handle(async (req, res) => {
    companyContext.assertNoForeignCompany(req.costing, req.body);
    const { policy } = await policyService.savePolicy(req.costing, req.body || {});
    return res.json({
      success: true,
      revision: policy.revision,
      policy: {
        baseCurrency: policy.baseCurrency,
        roundingMode: policy.roundingMode,
        sellingPriceIncrementMinor: policy.sellingPriceIncrementMinor,
        overheadBasis: policy.overheadBasis ?? null,
        overheadRatePercent: policy.overheadRatePercent ?? null,
        /* Echoed for the same reason the GET carries them: a screen that
           cannot read back what it just saved cannot show the company its
           own rules. */
        financingBasis: policy.financingBasis ?? null,
        financingRatePercent: policy.financingRatePercent ?? null,
        /* The legacy values, matching the GET: echoing the Board's decision
           back from a costing-policy save would tell the screen it had just
           written something it cannot write. */
        contingencyBasis: policy.legacyContingencyBasis ?? null,
        contingencyRatePercent: policy.legacyContingencyRatePercent ?? null,
        inputGstTreatment: policy.inputGstTreatment ?? null,
        productiveMinutesPerMonth: policy.productiveMinutesPerMonth ?? null,
        labourEfficiencyPercent: policy.labourEfficiencyPercent ?? null,
        employerBurdenPercent: policy.employerBurdenPercent ?? null,
        machineBurdenTreatment: policy.machineBurdenTreatment ?? null,
        /* The legacy table, matching the GET: echoing the Board's catalogue
           back from a costing-policy save would tell the screen it had just
           written something it cannot write. */
        developmentCharges: policy.legacyDevelopmentCharges || [],
        /* The legacy values, matching the GET: echoing the Board's band back
           from a costing-policy save would tell the screen it had just written
           something it cannot write. */
        minimumMarginPercent: policy.legacyMinimumMarginPercent ?? null,
        targetMarginPercent: policy.legacyTargetMarginPercent ?? null,
        preferredMarginPercent: policy.legacyPreferredMarginPercent ?? null,
        approvalThresholdMarginPercent: policy.legacyApprovalThresholdMarginPercent ?? null,
        estimatedIncomeTaxRatePercent: policy.legacyEstimatedIncomeTaxRatePercent ?? null,
        revision: policy.revision,
      },
      configured: true,
      canManage: true,
    });
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

    /* ── WHAT THE ROW IS ABOUT, TODAY ────────────────────────────────
       Alongside the frozen snapshot, never instead of it: the snapshot is
       what the costing said when it was made, and a work queue is about the
       work in front of somebody now. Carries no cost, price or margin. */
    const subjects = await enquiryLookup.subjectsFor(req.costing, allowed);

    return res.json({
      success: true,
      costings: allowed.map((c) => ({
        ...visibility.serializeCosting(c, req.costing),
        ...(subjects.has(String(c._id)) ? { subject: subjects.get(String(c._id)) } : {}),
      })),
      visibility: {
        capabilities: [...req.costing.capabilitySet].sort(),
        companyId: String(req.costing.companyId),
        membershipSource: req.costing.membershipSource,
      },
    });
  }),
);

/**
 * GET /api/costings/lookup/enquiry-products — what can be costed.
 *
 * ── WHY THE PICKER IS A SERVER ENDPOINT AND NOT A SALES READ ────────────────
 * Composing a costing is costing work. Requiring a Sales grant to choose the
 * enquiry to cost would be the same ownership mistake this domain has made in
 * the other direction, so this is gated on the costing grant the person
 * already holds and returns only what the picker renders.
 *
 * Registered BEFORE `/:id`, or Express reads "lookup" as a costing id and
 * answers a non-disclosing 404 for a route that exists.
 */
router.get(
  "/lookup/enquiry-products",
  /* `draft.write`, because this exists to START a costing. A reader who
     cannot create one has no use for a list of things to create. */
  requireCapability(CAPABILITIES.DRAFT_WRITE),
  handle(async (req, res) => {
    const { products, capped } = await enquiryLookup.eligibleProducts(req.costing, {
      search: req.query.q || req.query.search || "",
      limit: req.query.limit,
    });
    return res.json({
      success: true,
      products,
      /* Said, not inferred — a capped list is not a complete one, and a
         person who cannot see their enquiry needs to know to search. */
      capped,
    });
  }),
);

/**
 * GET /api/costings/:id — one costing and its current version.
 */
/* ══════════════════════════════════════════════════════════════════════════
 * THE COSTING EDITOR'S OWN LOOKUPS — Chunk 3.2
 *
 * A person composing a costing has to choose an item, a variant and a supplier
 * quotation. They must not have to type an ObjectId, and they must not need
 * STORE permissions to do it: composing a costing is costing work, and
 * requiring `sp.read` to fill in a cost line would be the same ownership
 * mistake in the other direction.
 *
 * So these two reads are narrow, company-scoped and gated on the costing
 * grant the editor already holds. They return only what the picker renders.
 * ═════════════════════════════════════════════════════════════════════════ */

/**
 * GET /api/costings/lookup/items?search= — the Item Master, for picking.
 *
 * Name and SKU only, capped hard. This is a picker, not a catalogue browser:
 * nothing here returns stock, suppliers, prices or reorder levels, because a
 * costing editor has no business reading them through this door.
 */
router.get(
  "/lookup/items",
  requireAnyCapability(CAPABILITIES.COST_READ, CAPABILITIES.DRAFT_WRITE),
  handle(async (req, res) => {
    const search = String(req.query.search || "").trim();
    const RawItem = require("../../../models/CMS_Models/Inventory/Products/RawItem");

    const filter = { ...companyContext.companyFilter(req.costing) };
    if (search) {
      /* Escaped: an item master legitimately contains "(", "+" and "*", and
         an unescaped one is a 500 or a runaway scan, not a search. */
      const safe = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      filter.$or = [
        { name: { $regex: safe, $options: "i" } },
        { sku: { $regex: safe, $options: "i" } },
      ];
    }

    const items = await RawItem.find(filter)
      .select("_id name sku unit customUnit variants")
      .sort({ name: 1 })
      .limit(20)
      .lean();

    return res.json({
      success: true,
      items: items.map((i) => ({
        itemId: String(i._id),
        name: i.name || "",
        sku: i.sku || "",
        /* The item's own unit, offered as the default consumption unit —
           the commonest answer, and still editable. */
        baseUom: i.customUnit || i.unit || "",
        variants: (i.variants || []).map((v) => ({
          variantId: String(v._id),
          label: (v.combination || []).join(" / ") || v.sku || "",
          sku: v.sku || "",
        })),
      })),
      /* Said rather than inferred from a round number. */
      capped: items.length === 20,
    });
  }),
);

/**
 * GET /approved-output — the price Sales may quote, and nothing else.
 *
 * ── A SEPARATE READ, NOT A FILTERED ONE ─────────────────────────────────────
 * Gated on `costing.output.read`, the capability that has always meant "may
 * read the approved commercial output" and which `visibility.js` keeps distinct
 * from `cost.read` and `margin.read`. The handler never loads the cost block,
 * the supplier provenance, the margin band or the profit bridge — they are not
 * in the projection, so they are never in memory to leak. Fetching the whole
 * version and hiding fields in React would mean the data had already crossed
 * the boundary.
 *
 * ── ADDRESSED BY STYLE, NEVER BY NAME ───────────────────────────────────────
 * `sampleStyleId` is the key. Product name, SKU text and array position are
 * not accepted, because each of them silently repoints the price the first
 * time somebody renames or reorders something.
 */
router.get(
  "/approved-output",
  requireCapability(CAPABILITIES.OUTPUT_READ),
  handle(async (req, res) => {
    const out = await approvedOutput.approvedOutputFor(req.costing, {
      sampleStyleId: String(req.query.sampleStyleId || "").trim(),
      /* Optional: without it, the whole approved break list comes back so a
         screen can show what IS available. With it, an exact match or a
         refusal — never the nearest. */
      quantity: String(req.query.quantity || "").trim() || undefined,
      currency: String(req.query.currency || "").trim() || undefined,
    });
    /* An unavailable answer is a 200 carrying a reason, not a 404: "there is
       no approved price for 1,200" is information Sales acts on, and a missing
       style, an unapproved costing and a quantity gap need different actions. */
    return res.json({ success: true, ...out });
  }),
);

/**
 * GET /api/costings/lookup/offers — the quotations that could price a line.
 *
 * Backed by the Store read adapter, which is the one place that decides what
 * "current" means. Every candidate is priced THROUGH the same resolver the
 * calculation uses, so what the picker shows and what the version freezes
 * cannot disagree — an unusable candidate comes back with the exact reason
 * rather than being hidden, because "no quotations" and "three quotations you
 * cannot use, and why" are different answers.
 */
router.get(
  "/lookup/offers",
  requireAnyCapability(CAPABILITIES.COST_READ, CAPABILITIES.DRAFT_WRITE),
  handle(async (req, res) => {
    const itemId = String(req.query.itemId || "").trim();
    if (!mongoose.Types.ObjectId.isValid(itemId)) {
      return res.json({ success: true, candidates: [], asOf: new Date() });
    }
    const variantId = String(req.query.variantId || "").trim() || null;
    const consumptionUom = String(req.query.consumptionUom || "").trim();
    const quantityPerUnit = String(req.query.quantityPerUnit || "").trim();
    const outputs = String(req.query.scenarioQuantities || "")
      .split(",").map((x) => Number(String(x).trim()))
      .filter((n) => Number.isFinite(n) && n > 0);

    const asOf = req.query.asOf ? new Date(req.query.asOf) : new Date();
    const { policy } = await policyService.getPolicy(req.costing);

    const facts = await offerRead.currentOffersForItem(
      { companyId: req.costing.companyId, actorId: req.costing.actorId, reason: "costing_offer_picker" },
      itemId, { variantId, asOf },
    );

    /* Priced one at a time through the real resolver. A candidate that would
       be refused at calculation is shown as unusable HERE, with the same
       code — so the person is never offered a choice the save then rejects. */
    const candidates = [];
    for (const offer of facts) {
      const base = {
        offerId: offer.offerId,
        supplierName: offer.supplierName,
        quotationReference: offer.quotationReference,
        revision: offer.revision,
        supplierItemCode: offer.supplierItemCode,
        currency: offer.currency,
        quotedAmountMinor: offer.unitPriceMinor,
        priceBasis: offer.priceBasis,
        /* ── AND WHETHER IT LANDS HERE ────────────────────────────────
           Two quotations at the same rate are not the same offer when one
           delivers to our warehouse and the other does not. A buyer choosing
           between them needs to see it. */
        freightTerms: offer.freightTerms || null,
        incoterm: offer.incoterm || null,
        gstRatePercent: offer.gstRatePercent,
        gstRecorded: offer.gstRatePercent !== null,
        purchaseUom: offer.purchaseUom,
        moq: offer.moq,
        orderMultiple: offer.orderMultiple,
        leadTimeDays: offer.leadTimeDays,
        effectiveFrom: offer.effectiveFrom,
        validUntil: offer.validUntil,
        tiers: offer.tiers,
      };
      try {
        const resolved = await offerPricing.resolveLineRate(req.costing, {
          supplierOfferId: offer.offerId,
          itemId, variantId, consumptionUom,
          category: "MATERIAL", behaviour: "PER_UNIT",
          quantityPerUnit: quantityPerUnit || undefined,
          scenarioQuantities: outputs,
          asOf,
          costingCurrency: policy.baseCurrency,
          roundingMode: policy.roundingMode,
          /* The line's own stated recoverability, so the picker reaches the
             SAME verdict the save will. A line that has not said yet shows
             the quotation as unusable with that exact reason, which is what
             the person has to resolve anyway. */
          taxTreatment: String(req.query.taxTreatment || "").trim() || undefined,
        });
        candidates.push({
          ...base,
          usable: true,
          reason: null,
          rateMinor: resolved.rateMinor,
          appliedPurchaseQuantity: resolved.provenance.appliedPurchaseQuantity,
          scenarioQuantities: resolved.provenance.scenarioQuantities,
          priceSource: resolved.provenance.priceSource,
          tierMinQuantity: resolved.provenance.tierMinQuantity,
          netRateMinor: resolved.provenance.netRateMinor,
          gstAmountMinor: resolved.provenance.gstAmountMinor,
          grossRateMinor: resolved.provenance.grossRateMinor,
          gstTreatment: resolved.provenance.gstTreatment,
          hsnCode: resolved.provenance.hsnCode,
          conversionPath: resolved.provenance.conversionPath,
          conversionFactor: resolved.provenance.conversionFactor,
          warnings: resolved.warnings,
        });
      } catch (err) {
        /* Visible, and explained. Hiding it would leave the person wondering
           why the supplier they expected is missing. */
        candidates.push({
          ...base,
          usable: false,
          reason: { code: err?.code || "UNKNOWN", message: err?.message || "", details: err?.details || {} },
          warnings: [],
        });
      }
    }

    return res.json({ success: true, candidates, asOf, currency: policy.baseCurrency });
  }),
);

/**
 * GET /api/costings/:id/procurement-projection — what this will need buying.
 *
 * ── A FORECAST, NOT A DOCUMENT ──────────────────────────────────────────────
 * Read-only in the strongest sense: it creates no requisition, no MRF, no
 * commitment, no reservation, no purchase order and no supplier contact, and
 * it does not touch the costing. It reads one frozen APPROVED version and says
 * what that version implies somebody will have to buy.
 *
 * ── AND IT IS COST DATA ─────────────────────────────────────────────────────
 * What the company pays a supplier is the inside of the cost build-up. An
 * output-only Sales reader may see an approved SELLING price and nothing
 * behind it, so this requires `costing.cost.read` — deliberately NOT the
 * permissive `requireAnyCapability` list the detail endpoint uses, which
 * admits `OUTPUT_READ`.
 *
 * Declared BEFORE `/:id`, or Express matches "procurement-projection" as an
 * id and answers 404 — the same ordering rule the lookup routes follow.
 */
router.get(
  "/:id/procurement-projection",
  requireCapability(CAPABILITIES.COST_READ),
  handle(async (req, res) => {
    const out = await procurementProjection.projectFor(req.costing, {
      costingId: req.params.id,
      /* Exact, or a refusal. Never the nearest approved quantity. */
      scenarioKey: String(req.query.scenarioKey || "").trim() || undefined,
    });
    /* An unavailable projection is a 200 carrying a reason: "nothing has been
       approved yet" is information the screen acts on, and it needs different
       words from "that costing does not exist". */
    return res.json({ success: true, ...out });
  }),
);

/**
 * GET /:id/procurement-projection/requests — the projection, ready to request.
 *
 * The projection plus each requirement's own request history, so the review
 * screen can show what has already been asked for and refuse to ask twice.
 * Still a pure read: it creates nothing.
 */
router.get(
  "/:id/procurement-projection/requests",
  requireCapability(CAPABILITIES.COST_READ),
  handle(async (req, res) => {
    const out = await projectionHandoff.prepare(req.costing, {
      costingId: req.params.id,
      scenarioKey: String(req.query.scenarioKey || "").trim() || undefined,
    });
    return res.json({ success: true, ...out });
  }),
);

/**
 * POST /:id/procurement-projection/requests — create the draft requests.
 *
 * ── DRAFTS ONLY ─────────────────────────────────────────────────────────────
 * It approves no spending, reserves no budget, creates no commitment, no
 * purchase order, no service order, no material request and no stock
 * reservation. It writes at most two DRAFT spend requests and stops.
 *
 * ── AND THE BODY CHOOSES RATHER THAN DESCRIBES ──────────────────────────────
 * Only the four selection fields below are read. Quantity, unit, rate, amount,
 * supplier, quotation, tax, item identity and budget head are regenerated from
 * the frozen approved version; a posted one is not validated, it is simply
 * never looked at.
 *
 * `DRAFT_WRITE` because this creates a record. Reading a projection needs
 * `COST_READ`; raising demand from it is a different act.
 */
/**
 * DEPRECATED — releasing demand moved to the confirmed order.
 *
 * ── WHY IT IS STILL HERE ────────────────────────────────────────────────────
 * It is the only path any existing caller knows, and deleting it would break
 * them mid-migration. It is kept working and unchanged, and NO new caller is
 * added to it.
 *
 * ── AND WHY IT SHOULD GO ────────────────────────────────────────────────────
 * Its only precondition is that the costing has an approved version — which
 * says a PRICE MAY BE QUOTED, not that the company has an order. It cannot see
 * whether a customer confirmed anything, cannot check that the ordered
 * quantity is one the costing was approved for, and cannot tell an order line
 * from a style. So it can raise purchasing demand for an enquiry nobody
 * ordered.
 *
 * The replacement is `POST /api/merchandising/execution/demand-release`, which
 * names the confirmed order, its permanent line reference and the exact
 * approved costing version, and refuses every case above by name. Retire this
 * route once the Merchandising control is in use.
 */
/* ── RETIRED: THE DOOR IS SHUT, AND SAYS SO ─────────────────────────────────
 *
 * It is no longer deprecated-but-working. Everything the comment above
 * describes was true and remained reachable by anybody holding
 * `costing.draft.write`: purchasing demand for an enquiry nobody ordered, at a
 * quantity no confirmed order line named, with no reconciliation of demand
 * already released.
 *
 * Procurement demand now has exactly one origin — the confirmed-order
 * demand-release authority, which names the order, its permanent line
 * reference and the exact approved costing version, and which refuses a
 * successor while prior demand is unreconciled.
 *
 * Refused rather than removed: a caller that still posts here gets a typed
 * answer naming the replacement, not a 404 that reads as a broken deploy.
 * Records raised through it before today are untouched and still readable.
 */
router.post(
  "/:id/procurement-projection/requests",
  requireCapability(CAPABILITIES.DRAFT_WRITE),
  handle(async (req, res) => res.status(410).json({
    success: false,
    error: {
      code: "PROCUREMENT_PROJECTION_RETIRED",
      message: "Procurement demand is released from the confirmed order, not from a costing. "
        + "Open the order's execution file and release the demand there.",
      details: {
        reason: "MOVED_TO_CONFIRMED_ORDER",
        use: "POST /api/cms/merchandising/execution/files/:fileId/demand-release",
      },
    },
    message: "Procurement demand is released from the confirmed order, not from a costing.",
  })),
);

/**
 * GET /:id/actual-procurement — the estimate beside what was actually spent.
 *
 * ── READ-ONLY ───────────────────────────────────────────────────────────────
 * It writes nothing: not a costing version, not a request, not an order, not a
 * voucher, not a landed-cost allocation, not stock. It reads records other
 * lanes own, through their stored identifiers, and reports what they say.
 *
 * ── AND IT IS COST DATA ─────────────────────────────────────────────────────
 * What a supplier actually billed is the inside of the cost build-up, so this
 * requires `costing.cost.read` — deliberately not the permissive list the
 * detail endpoint uses, which admits an output-only Sales reader.
 */
router.get(
  "/:id/actual-procurement",
  requireCapability(CAPABILITIES.COST_READ),
  handle(async (req, res) => {
    const out = await actualProcurement.reportFor(req.costing, {
      costingId: req.params.id,
      scenarioKey: String(req.query.scenarioKey || "").trim() || undefined,
    });
    return res.json({ success: true, ...out });
  }),
);

/**
 * GET /:id/actual-cost — the estimate beside procurement AND production.
 *
 * Chunk 8A's procurement report, composed with what production consumed, made
 * and cost. Read-only in the strongest sense: nothing anywhere is written.
 * Cost data, so `costing.cost.read` — an output-only Sales reader may not see
 * what the company paid or what it cost to make.
 */
router.get(
  "/:id/actual-cost",
  requireCapability(CAPABILITIES.COST_READ),
  handle(async (req, res) => {
    const out = await productionActual.reportFor(req.costing, {
      costingId: req.params.id,
      scenarioKey: String(req.query.scenarioKey || "").trim() || undefined,
    });
    return res.json({ success: true, ...out });
  }),
);

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

    /* ── "CURRENT" MEANS TWO DIFFERENT THINGS ─────────────────────────────
       An internal reader wants the newest working version — that is what they
       are editing. An output-only reader wants the APPROVED one, which may be
       several versions behind it and must not move when somebody saves a
       draft. Resolved separately rather than by one field pretending to
       answer both. */
    const internal = visibility.canSeeInternalRecord(req.costing);
    const shown = internal
      ? (versions.find((v) => String(v._id) === String(costing.currentVersionId))
        || versions[versions.length - 1]
        || null)
      : (visibleVersions(req, costing, versions)[0] || null);

    return res.json({
      success: true,
      /* Where Sales would pick this price up, when that can be PROVED. */
      salesDestination: await salesDestinationFor(costing),
      ...visibility.serialize({
        costing,
        versions: shown ? [shown] : [],
        ctx: req.costing,
      }),
    });
  }),
);

/**
 * Where a person would go in Sales to use this approved price — or null.
 *
 * ── STORED IDS, TWO HOPS, AND NO GUESSING ───────────────────────────────────
 * An `ENQUIRY_STYLE` costing knows its enquiry (`context.primaryId`). The
 * enquiry knows its journey (`Enquiry.journeyId`, unique — one enquiry per
 * journey). The journey knows its lead (`SalesJourney.leadId`), which is what
 * the Sales workspace route is actually keyed by. Every hop is an id somebody
 * stored; not one is a name, a product or a guess.
 *
 * ── AND IT RETURNS NULL OFTEN, ON PURPOSE ───────────────────────────────────
 * `leadId` is SPARSE: a journey raised without a lead has none, and today
 * about half do not. A link built anyway would be a dead button on half the
 * costings in the system — worse than no button, because a dead link teaches
 * people the screen is broken. So the destination is resolved server-side and
 * returned only when the whole chain resolves; the panel renders the action
 * only when one came back, and otherwise keeps its explanation.
 *
 * Read-only, id-only. It reveals no Sales data: whether a journey exists is
 * something the costing's own enquiry already told this reader.
 */
async function salesDestinationFor(costing) {
  try {
    if (costing?.context?.type !== "ENQUIRY_STYLE" || !costing.context.primaryId) return null;
    const Enquiry = require("../../../models/CMS_Models/Sales/Enquiry");
    const SalesJourney = require("../../../models/CMS_Models/Sales/SalesJourney");
    /* The company clause is in the same query as the id: another company's
       enquiry must not resolve, even to a journey id. */
    const companyClause = { companyId: costing.companyId };
    const enquiry = await Enquiry.findOne({ _id: costing.context.primaryId, ...companyClause }).select("journeyId").lean();
    if (!enquiry?.journeyId) return null;
    /* tenancy-guard:reviewed-public-token — the journey id came from an enquiry just read under this costing's company clause, and only an id is returned. This exempts THIS query only. */
    const journey = await SalesJourney.findById(enquiry.journeyId).select("leadId").lean();
    if (!journey?.leadId) return null;
    return { journeyId: String(enquiry.journeyId), leadId: String(journey.leadId) };
  } catch (err) {
    /* A destination that cannot be resolved is simply absent. It is a
       convenience, and it must never be able to fail the costing read. */
    return null;
  }
}

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

    /* History is an internal idea. To an output-only reader there is one
       commercial answer and no history of how it was argued — returning the
       whole list would disclose every draft that ever existed. */
    return res.json({
      success: true,
      ...visibility.serialize({
        costing, versions: visibleVersions(req, costing, versions), ctx: req.costing,
      }),
    });
  }),
);

/* ══════════════════════════════════════════════════════════════════════════
 * CALCULATE A NEW VERSION
 * ═════════════════════════════════════════════════════════════════════════ */

/**
 * POST /api/costings/:id/versions — calculate, and freeze the result.
 *
 * ── WHY THIS CREATES RATHER THAN UPDATES ────────────────────────────────────
 * Re-costing is not editing. Roadmap decision 8: a later change to a supplier
 * price, an overhead policy or a consumption figure creates a NEW version and
 * never alters an old one. So there is no "recalculate this version" endpoint,
 * and the model would refuse one if it were written.
 */
/**
 * GET /:id/technical-source — the style(s) this costing could be built from.
 *
 * ── SEVERAL IS A REAL ANSWER ────────────────────────────────────────────────
 * One enquiry product may be developed as sibling variant styles — the same
 * polo in navy poly-cotton and in white PC, offered together so the customer
 * picks. Returning the first would cost one and label it the other, and the
 * mistake would be invisible: the numbers would look perfectly reasonable.
 * Every proven match is returned with its style code and where its technical
 * information stands, and the person chooses.
 *
 * Ownership is proved through the Sales Journey, which is company-scoped;
 * SampleStyle itself is not. A style belonging to another company is not
 * listed as unavailable — it is not listed.
 */
router.get(
  "/:id/technical-source",
  requireAnyCapability(CAPABILITIES.COST_READ, CAPABILITIES.DRAFT_WRITE),
  handle(async (req, res) => {
    const costing = await loadCosting(req);
    if (costing.context?.type !== "ENQUIRY_STYLE") {
      /* Honest about the boundary rather than returning an empty list, which
         would read as "this style has no technical data". */
      return res.status(422).json({
        success: false,
        error: {
          code: technicalSource.CODES.CONTEXT_NOT_TECHNICAL,
          message: "Only a costing raised against an enquiry style has a technical record to import.",
          details: { contextType: costing.context?.type || null, supported: ["ENQUIRY_STYLE"] },
        },
      });
    }
    const { candidates } = await technicalSource.findCandidates(req.costing, {
      enquiryId: costing.context.primaryId,
      productName: costing.context.externalKey,
    });
    return res.json({
      success: true,
      product: costing.context.externalKey,
      candidates,
      /* Said explicitly so the screen never has to infer it from the length. */
      several: candidates.length > 1,
    });
  }),
);

/**
 * GET /:id/technical-preview?styleId= — what the import WOULD bring in.
 *
 * ── READ-ONLY, AND REPEATEDLY SO ────────────────────────────────────────────
 * No version, no draft, no side effect. Opening the preview twice produces the
 * same answer and leaves the costing exactly as it was found, so somebody can
 * look at what the technical record says without that being a decision.
 */
router.get(
  "/:id/technical-preview",
  requireAnyCapability(CAPABILITIES.COST_READ, CAPABILITIES.DRAFT_WRITE),
  handle(async (req, res) => {
    const costing = await loadCosting(req);
    if (costing.context?.type !== "ENQUIRY_STYLE") {
      return res.status(422).json({
        success: false,
        error: {
          code: technicalSource.CODES.CONTEXT_NOT_TECHNICAL,
          message: "Only a costing raised against an enquiry style has a technical record to import.",
          details: { contextType: costing.context?.type || null, supported: ["ENQUIRY_STYLE"] },
        },
      });
    }

    /* ── ONE ASSEMBLY, TWO READERS ────────────────────────────────────────
       This route used to stitch the candidates, the preview and the policy
       together itself, and version creation stitched them together again on
       save. Two careful implementations of one thing is two answers to the
       same question, and the only way to learn they disagreed was to watch a
       number change on save. Both now call `assembly.assemble`. */
    /* ── WHICH STYLE, FROM SALES — NOT FROM THE QUERY STRING ─────────────
       `?styleId=` chose it, which made the preview show whatever the browser
       asked for. Which approved style is being quoted is a commercial
       decision; Sales confirms it on the enquiry and this READS it.

       A preview REPORTS the absence rather than refusing: somebody opening a
       costing whose brief has not been confirmed should be told so, and told
       whose it is, not met with an error about a technical record. */
    let brief = null;
    let briefBlocker = null;
    try {
      brief = await salesBrief.requireConfirmedBrief(req.costing, costing);
    } catch (err) {
      if (err?.code !== "COSTING_BRIEF_REQUIRED") throw err;
      briefBlocker = { code: err.code, message: err.message, details: err.details || {} };
    }
    const briefStyleId = brief ? String(brief.sampleStyleId || "") : null;

    const assembled = await assembly.assembleLines(req.costing, costing, {
      styleId: briefStyleId,
      policy: (await policyService.getPolicy(req.costing)).policy,
      /* Preview and save assemble identically; the preview simply has no
         scenarios yet, so quotation applicability is reported for the
         quantities it does know about. */
      scenarios: [],
    }).catch((err) => (err?.code === "COSTING_AWAITING_SOURCE"
      /* A preview REPORTS the state; only a save refuses on it. */
      ? assembly.assemble(req.costing, costing, { styleId: briefStyleId })
      : Promise.reject(err)));

    /* ── AND SEVERAL RECORDS IS NO LONGER THIS SCREEN'S QUESTION ──────────
       It used to be a 409 asking whoever was costing to choose between
       siblings. They had a style code and a variant label to choose on, and
       no way to know which one the customer is being quoted. Sales does, so
       an unconfirmed brief is reported as exactly that — with Sales named —
       and the candidates are NOT published here: a list of styles to pick
       from is an invitation to pick one. */
    if (assembled.state === assembly.STATE.SEVERAL_TECHNICAL_RECORDS) {
      return res.status(409).json({
        success: false,
        error: {
          code: "COSTING_BRIEF_REQUIRED",
          message: "This product has more than one style, and Sales has not confirmed which one is being quoted.",
          details: {
            reason: "NO_CONFIRMED_BRIEF",
            owner: salesBrief.OWNER,
            styleCount: (assembled.candidates || []).length,
          },
        },
      });
    }

    /* ── THE PRESENTATION CONTRACT ────────────────────────────────────
       Built from the SAME generated rows version creation is built from, so a
       figure on screen is the figure that will be frozen. This returned
       `assembled.technical` — the raw sample facts — and dropped the assembled
       rows entirely, which is how the screen came to show the sample's legacy
       ₹2.16 as verified while the version froze the policy-derived ₹3.54. */
    const view = assembly.presentAssembly(assembled);

    return res.json({
      success: true,
      assembly: view,
      /* Kept for the technical panel, which legitimately shows what the RECORD
         says rather than what the costing will use. */
      preview: assembled.technical,
      candidates: assembled.candidates,
      product: costing.context.externalKey,
      /* ── WHAT SALES ASKED TO BE COSTED ────────────────────────────────
         Read-only, and the whole commercial half of this screen: the style,
         the quantities, the unit, the proposed prices and the note. A costing
         reader sees WHAT was asked; they cannot change any of it here, and
         `briefBlocker` is what stands in its place when Sales has not asked
         yet — a named owner and a destination rather than a blank editor. */
      brief: brief || null,
      briefBlocker,
      /* ── THE WORKFLOW STATE, NAMED ────────────────────────────────────
         `preview: null` meant three different things — no record, several
         records, or an ad-hoc costing — and left the screen to guess which.
         Each is now its own state, and each names the department that owns
         the gap so the answer is "ask R&D", not "add a manual line". */
      state: assembled.state,
      missing: assembled.missing,
      policy: assembled.policy,
      coverage: assembled.coverage,
    });
  }),
);

router.post(
  "/:id/versions",
  requireCapability(CAPABILITIES.DRAFT_WRITE),
  /* The key is bound to the costing in the URL, not just the body: the same
     lines posted to two costings are byte-identical bodies, and without the
     target the second replays the first's answer. Server-derived — a target a
     caller could name is a target a caller could aim anywhere. */
  withIdempotency("COSTING_VERSION_CREATE", { target: versionTarget }),
  handle(async (req, res) => {
    companyContext.assertNoForeignCompany(req.costing, req.body);
    const costing = await loadCosting(req);
    /* A historical manual costing is readable, not revisable. */
    refuseHistoricalManual(costing, "be re-costed");

    /* ── PREPARING AN ESTIMATE IS A SALES ACTION ─────────────────────────
       This route was the Calculate button. Central Costing is an engine: it
       assembles departmental facts, applies quotations and effective Board
       policies, calculates and versions. None of that is a screen anybody
       outside it should have to open in order for Sales to learn what a
       garment costs.

       ── AND THE BUTTON WAS NOT MERELY HIDDEN ────────────────────────────
       Removing the control while leaving the route open would leave an
       unrestricted equivalent write: a stale tab, a bookmark or anything
       holding the endpoint could still create versions outside the
       orchestration, with no brief resolved and no fingerprint frozen.

       The ENGINE is untouched. `versionCreation.createNextVersion` is called
       by `services/sales/costingPreparation.service.js` exactly as it was
       called here — same creation claim, same idempotency, same assembly.
       What is refused is the HTTP door, and only for a costing raised
       against an enquiry product, which is the only kind Sales briefs. */
    if (costing.context?.type === "ENQUIRY_STYLE") {
      throw fail("COSTING_PREPARATION_MOVED_TO_SALES",
        "Estimates are prepared from the enquiry. Central Costing assembles the facts, applies the "
        + "company's policies and calculates — it is not a screen anybody opens to start one.",
        {
          reason: "PREPARATION_MOVED_TO_SALES",
          owner: { department: "Sales", recordedIn: "Enquiry · Costing brief" },
          /* Where, precisely. A refusal with no address is what sends people
             looking for another way in. */
          prepareAt: "/sales/dashboard/journeys",
          enquiryId: String(costing.context.primaryId || ""),
          product: costing.context.externalKey || null,
        });
    }

    /* Same rule as the parent create: ask the versions collection whether this
       exact user action already produced one, BEFORE writing. The claim is on
       the version itself, so the answer does not depend on bookkeeping that
       might have failed. */
    const recovered = await recoverExistingVersion(req, res, costing);
    if (recovered) return recovered;

    /* ── THE CURRENCY IS THE COMPANY'S, NOT THE CALLER'S ─────────────────
       Read from the policy before the body is parsed, so a payload cannot
       choose the currency a company costs in. */
    const policyBundle = await policyService.getPolicy(req.costing);
    /* ── AND AN UNSET POLICY IS NOT A 0% MARGIN ──────────────────────────
       Refused here, before the body is even parsed, so the caller gets the
       answer that is actually true — "nobody has set the rules yet" — rather
       than a validation error about a cost line. Nothing is written, the
       parent pointer does not move, and the error path releases the
       idempotency claim so the key can be used again once policy exists. */
    policyService.assertConfigured(policyBundle);
    const { policy } = policyBundle;
    const parsed = parseCalculationRequest(req.body || {}, {
      currency: policy.baseCurrency,
      /* A costing raised against an enquiry product has its technical rows
         built by the server, so it may legitimately send none of its own. */
      assembled: costing.context?.type === "ENQUIRY_STYLE",
    });

    /* ── WHAT SALES ASKED TO BE COSTED, READ FROM THEIR RECORD ───────────
       The style, the quantities, the unit, the proposed price and the note
       used to arrive on this body. They are commercial decisions and they are
       Sales', so the costing reads the brief they confirmed — and refuses to
       calculate at all when there is none, naming Sales rather than
       defaulting a quantity, a unit, or worse, a style. */
    const brief = await salesBrief.requireConfirmedBrief(req.costing, costing);
    const fromBrief = salesBrief.toCalculationInput(brief);
    const input = {
      ...parsed,
      /* Validated by the SAME rule the payload used to be, so the engine's
         scenario contract keeps exactly one authority. */
      scenarios: parseScenarios(fromBrief.scenarios),
      note: fromBrief.note,
      technicalStyleId: fromBrief.technicalStyleId,
    };

    let created;
    try {
      created = await versionCreation.createNextVersion(req.costing, costing, input, {
        requestId: req.id || "",
        idempotencyKey: req.idempotent?.key || "",
        claim: req.idempotent
          ? {
              claimId: req.idempotent.claimId,
              requestHash: req.idempotent.requestHash,
              /* The schema has declared this since the correction pass and
                 nothing wrote it: the field existed, was always empty, and the
                 cross-costing check leaned entirely on `costingId`. Passing it
                 makes the stored claim say what it was spent on rather than
                 leaving that to be inferred. */
              target: req.idempotent.claimTarget,
            }
          : null,
        origin: "MANUAL",
        /* ── AND WHICH WORDING OF THE REQUEST THIS ANSWERED ───────────
           The brief's id and its revision, frozen with the version, so a
           reader can tell a costing made against the quantities Sales asked
           for on Monday from one made against Thursday's. */
        sourceReferences: [salesBrief.briefProvenance(brief)],
        onCommitted: null,
      });
    } catch (err) {
      if (err?.name === "CostingVersionClaimAlreadyUsed") {
        const late = await recoverExistingVersion(req, res, costing);
        if (late) return late;
      }
      throw err;
    }

    await req.idempotent?.markEffect(ENTITY, costing._id);
    if (req.idempotent?.claimId) {
      /* The version already carries this claim in its own provenance. The
         receipt makes the record uniform: every spent key, creating or
         aliasing, is findable in one place. */
      await versionCreation.recordClaimReceipt(req.costing, {
        claim: {
          claimId: req.idempotent.claimId,
          requestHash: req.idempotent.requestHash,
          target: req.idempotent.claimTarget,
        },
        operation: "COSTING_VERSION_CREATE",
        costing,
        version: created.version,
        resolution: "CREATED",
        /* The version's own provenance is this key's binding; the receipt is
           for uniform lookup. A manual calculation always creates, so there is
           never an alias to protect here. */
        mandatory: false,
      });
    }

    /* Re-read the parent so the response carries the pointer this write just
       moved, rather than the value it held when the request arrived. */
    const parent = await loadCosting(req);
    const body = {
      success: true,
      ...visibility.serialize({ costing: parent, versions: [created.version], ctx: req.costing }),
      /* Always true by the time a version exists — an unconfigured company
         cannot get here at all. Kept in the envelope because a client reads it
         to decide what to show, and removing a field is a contract change. */
      policyConfigured: true,
    };

    return req.idempotent
      ? req.idempotent.succeed(201, body, { entityType: ENTITY, entityId: costing._id })
      : res.status(201).json(body);
  }),
);

/** The version this exact user action already created, if it did. */
/**
 * The version this exact user action already created, if it did.
 *
 * Returns a sent response, or `null` to mean "carry on and create it".
 *
 * ── THREE OUTCOMES, AND THE MIDDLE ONE IS THE FIX ───────────────────────────
 *   · no claim spent            → create.
 *   · claim spent on THIS costing, same payload → recover it.
 *   · claim spent on ANOTHER costing, or on this one with a different payload
 *     → 409. Previously the lookup was scoped to the costing in the URL, so a
 *     key reused against a second costing found nothing, went on to create,
 *     and lost the company-wide unique index — a 500 for what is a client
 *     reusing a key. It is now a stable refusal, and it stays one after the
 *     idempotency bookkeeping row has expired, because the claim and the
 *     target it was spent on live on the version itself.
 */
async function recoverExistingVersion(req, res, costing) {
  if (!req.idempotent?.claimId) return null;
  /* Receipt first, then the version-embedded claim. A key spent as an ALIAS on
     the legacy-import route — resolving to a version it did not create — must
     be just as unusable here, or the manual route would become the way round
     the binding the import path now keeps. */
  const spent = await versionCreation.resolveClaim(req.costing, req.idempotent.claimId);
  if (!spent) return null;
  const existing = spent.version;

  const mismatch = claimMismatch(spent, costing, req.idempotent);
  if (mismatch) {
    throw fail(
      "IDEMPOTENCY_KEY_REUSED",
      "This request key was already used for a different request. Start the action again.",
      { operation: "COSTING_VERSION_CREATE", reason: mismatch },
    );
  }

  /* ── REPAIR BEFORE ANSWERING ────────────────────────────────────────────
     The first attempt may have inserted the version and then failed to move
     the parent's pointer. Handing the version back while `GET /costings/:id`
     still showed the previous one as current would make the same costing read
     two different ways. Forward-only, so this can never undo a later write. */
  await versionCreation.repairPointer(req.costing, costing, existing);

  const parent = await loadCosting(req);
  res.set("Idempotency-Recovered", "true");
  return req.idempotent.succeed(200, {
    success: true,
    ...visibility.serialize({ costing: parent, versions: [existing], ctx: req.costing }),
    recovered: true,
  }, { entityType: ENTITY, entityId: costing._id });
}

/* ══════════════════════════════════════════════════════════════════════════
 * LEGACY SALES COSTING SHEETS
 * ═════════════════════════════════════════════════════════════════════════ */

/** What is there to import, without importing it. */
router.get(
  "/:id/legacy-source",
  requireCapability(CAPABILITIES.COST_READ),
  handle(async (req, res) => {
    const costing = await loadCosting(req);
    const versions = await loadVersions(req, costing);
    assertMayRead(req, versions);
    return res.json({ success: true, legacySource: await legacyImport.describeLegacySource(req.costing, costing) });
  }),
);

/**
 * POST /api/costings/:id/versions/legacy-import — freeze the Sales sheet.
 *
 * Reads `Enquiry.costingSheets`; writes nothing to it. Importing the same
 * sheet in the same state twice returns the version that already exists —
 * keyed on the sheet's CONTENT, so an edited sheet legitimately produces a new
 * version while an unchanged one never duplicates.
 */
router.post(
  "/:id/versions/legacy-import",
  requireCapability(CAPABILITIES.DRAFT_WRITE),
  withIdempotency("COSTING_LEGACY_IMPORT", { target: versionTarget }),
  handle(async (req, res) => {
    companyContext.assertNoForeignCompany(req.costing, req.body);
    const costing = await loadCosting(req);
    /* Legacy import is a MIGRATION facility. Allowing it here would make it
       the alternative route to a current price for exactly the costings that
       may no longer produce one. */
    refuseHistoricalManual(costing, "be re-costed from the Sales sheet");

    const scenarios = parseScenariosForImport(req.body);
    const { version, recovered, report } = await legacyImport.importLegacySheets(req.costing, costing, {
      scenarios,
      meta: {
        requestId: req.id || "",
        idempotencyKey: req.idempotent?.key || "",
        note: typeof req.body?.note === "string" ? req.body.note.trim().slice(0, 500) : "",
        /* ── THE DURABLE CLAIM, WHICH THIS ROUTE WAS MISSING ────────────
           The temporary `SpIdempotencyRecord` was already bound to this
           costing, but nothing was written onto the version — so once that
           row expired (30 days) or was cleared, the same key could be spent
           again, here or against another costing, with nothing left to
           notice. The manual route has carried this since the correction
           pass; the import did not.

           Target comes from the URL via `versionTarget`, never the body. */
        claim: req.idempotent
          ? {
              claimId: req.idempotent.claimId,
              requestHash: req.idempotent.requestHash,
              target: req.idempotent.claimTarget,
            }
          : null,
      },
    });

    await req.idempotent?.markEffect(ENTITY, costing._id);
    const parent = await loadCosting(req);

    const body = {
      success: true,
      ...visibility.serialize({ costing: parent, versions: [version], ctx: req.costing }),
      recovered,
      /* ── WHAT COULD NOT BE READ, SAID OUT LOUD ────────────────────────
         A legacy row with an unreadable price is NOT imported as zero, and the
         person importing has to know which rows were left out — otherwise the
         costing looks complete and is not. */
      import: {
        importedLineCount: report.lines.length,
        unmapped: report.unmapped,
        ambiguities: report.ambiguities,
      },
    };
    return req.idempotent
      ? req.idempotent.succeed(recovered ? 200 : 201, body, { entityType: ENTITY, entityId: costing._id })
      : res.status(recovered ? 200 : 201).json(body);
  }),
);

/** An import still has to say what quantities to cost at. */
function parseScenariosForImport(body) {
  const { parseScenarios } = require("../../../services/centralCosting/calculationInput");
  return parseScenarios(body?.scenarios);
}

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
/* ══════════════════════════════════════════════════════════════════════════
 * LIFECYCLE — Chunk 6A
 *
 * Two operations, both idempotent, both company-scoped, and both delegating
 * every write to `lifecycle.service.js`. No status is assigned in this file:
 * a router that could set one would be a second place the rule lives, and the
 * two would disagree the first time either changed.
 * ═════════════════════════════════════════════════════════════════════════ */

/** The key is bound to the VERSION, not just the costing — two versions of one
    costing are two different actions and must not replay each other. */
const lifecycleTarget = (req) => `costing:${req.params.id}:version:${req.params.versionId}`;

/**
 * POST /api/costings/:id/versions/:versionId/submit — DRAFT → IN_REVIEW.
 *
 * Requires `costing.draft.write`: putting your own work forward is the
 * editor's act, not the approver's.
 */
router.post(
  "/:id/versions/:versionId/submit",
  requireCapability(CAPABILITIES.DRAFT_WRITE),
  withIdempotency("COSTING_SUBMIT_REVIEW", { target: lifecycleTarget }),
  handle(async (req, res) => {
    companyContext.assertNoForeignCompany(req.costing, req.body);
    const costing = await loadCosting(req);
    /* Readable history cannot re-enter the workflow. */
    refuseHistoricalManual(costing, "be submitted for review");
    const versions = await loadVersions(req, costing);
    assertMayRead(req, versions);

    const result = await lifecycle.submitForReview({
      companyId: req.costing.companyId,
      costingId: costing._id,
      versionId: req.params.versionId,
      actor: { id: req.costing.actorId, name: req.user?.name || "", email: req.user?.email || "" },
      note: typeof req.body?.note === "string" ? req.body.note : "",
      idempotencyKey: req.idempotent?.key || "",
      /* What the key was spent on, carried onto the DURABLE receipt — the
         temporary bookkeeping row expires, and after it has gone the
         transition is the only thing that can recognise a key aimed
         somewhere else. */
      target: req.idempotent?.claimTarget || "",
      requestId: req.id || "",
    });

    const body = await lifecycleResponse(req, costing, result);
    return req.idempotent ? req.idempotent.succeed(200, body) : res.json(body);
  }),
);

/**
 * POST /api/costings/:id/versions/:versionId/approve — IN_REVIEW → APPROVED.
 *
 * Requires `costing.approve`. Publishes the price breaks the ENGINE already
 * calculated for this frozen version; it recalculates nothing, so a supplier
 * rate that moved since the review cannot change what is being approved.
 */
router.post(
  "/:id/versions/:versionId/approve",
  requireCapability(CAPABILITIES.APPROVE),
  withIdempotency("COSTING_APPROVE", { target: lifecycleTarget }),
  handle(async (req, res) => {
    companyContext.assertNoForeignCompany(req.costing, req.body);
    const costing = await loadCosting(req);
    /* And it certainly cannot become the number Sales quotes. */
    refuseHistoricalManual(costing, "be approved");
    const versions = await loadVersions(req, costing);
    assertMayRead(req, versions);

    const result = await lifecycle.approve({
      companyId: req.costing.companyId,
      costingId: costing._id,
      versionId: req.params.versionId,
      actor: { id: req.costing.actorId, name: req.user?.name || "", email: req.user?.email || "" },
      note: typeof req.body?.note === "string" ? req.body.note : "",
      idempotencyKey: req.idempotent?.key || "",
      /* What the key was spent on, carried onto the DURABLE receipt — the
         temporary bookkeeping row expires, and after it has gone the
         transition is the only thing that can recognise a key aimed
         somewhere else. */
      target: req.idempotent?.claimTarget || "",
      requestId: req.id || "",
    });

    const body = await lifecycleResponse(req, costing, result);
    return req.idempotent ? req.idempotent.succeed(200, body) : res.json(body);
  }),
);

/** The decisions taken on one costing, newest first. Internal readers only —
    an output-only reader may see the approved price, not who argued about it. */
router.get(
  "/:id/transitions",
  requireCapability(CAPABILITIES.COST_READ),
  handle(async (req, res) => {
    const costing = await loadCosting(req);
    const versions = await loadVersions(req, costing);
    assertMayRead(req, versions);
    return res.json({
      success: true,
      transitions: await lifecycle.history({
        companyId: req.costing.companyId, costingId: costing._id,
      }),
    });
  }),
);

/**
 * One response shape for both operations, and for a replay of either.
 *
 * The whole costing is re-read and re-serialised rather than returning the
 * transition alone, so the client's next render comes from the server's own
 * view of the new state instead of being assembled from an assumption about
 * what the transition did.
 */
async function lifecycleResponse(req, costing, result) {
  const fresh = await Costing.findOne({
    ...companyContext.companyFilter(req.costing),
    _id: costing._id,
  });
  const versions = await loadVersions(req, fresh || costing);
  return {
    success: true,
    replayed: Boolean(result.replayed),
    transition: result.transition
      ? {
          kind: result.transition.kind,
          fromStatus: result.transition.fromStatus,
          toStatus: result.transition.toStatus,
          at: result.transition.at,
          actorName: result.transition.actorName || "",
          note: result.transition.note || "",
        }
      : null,
    ...visibility.serialize({ costing: fresh || costing, versions, ctx: req.costing }),
  };
}

router.use((err, _req, res, _next) => sendError(res, err));

module.exports = router;
