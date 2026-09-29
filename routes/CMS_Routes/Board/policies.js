// routes/CMS_Routes/Board/policies.js
//
// THE BOARD & EXECUTIVE POLICY SURFACE.
//
// ── WHY THIS IS NOT UNDER /api/costings ─────────────────────────────────────
// The same reason the departmental requirement lists are not: `/api/costings`
// is gated by a COSTING capability, and the Board holds none. Setting the
// company's financing rule and reading a style's costing are different
// authorities held by different people, and putting the first behind the
// second would mean the only way to be on the Board is to be a costing user.
//
// Central Costing is a calculation engine. It CONSUMES what is decided here
// and offers no way to enter it — see `policy.service.js`, which now refuses
// the retired financing fields on write.
//
// ── AND NO STYLE, ORDER OR CUSTOMER REACHES THIS FILE ───────────────────────
// A Board policy is a company-wide decision. Nothing here reads a costing, a
// supplier quotation, a departmental form or an individual negotiation, and
// nothing here returns one. What it publishes is the rule and its history.
"use strict";

const express = require("express");

const EmployeeAuthMiddleware = require("../../../Middlewear/EmployeeAuthMiddlewear");
const {
  MEMBERSHIP_SOURCES, resolveCompanyForActor,
} = require("../../../services/companyContext/companyMembership.service");
const { fail, sendError, handle } = require("../../../services/storePurchase/errors");
const { boardRole, canDo, assertBoard, BOARD_DEPT_SLUG } = require("../../../services/board/boardAccess");
const boardPolicy = require("../../../services/board/boardPolicy.service");
const developmentChargePolicy = require("../../../services/centralCosting/developmentChargePolicy.service");
const contingencyPolicy = require("../../../services/centralCosting/contingencyPolicy.service");
const marginPolicy = require("../../../services/centralCosting/marginPolicy.service");
const {
  POLICY_KEYS, ADVANCE_TREATMENTS,
  FINANCING_START_EVENTS, DAY_COUNT_BASES, MACHINE_BURDEN_TREATMENTS,
  GST_TREATMENTS, DEVELOPMENT_CALCULATIONS, CONTINGENCY_MODES,
  PAYLOAD_FIELD: BOARD_PAYLOAD_FIELD,
} = require("../../../models/CMS_Models/Board/BoardPolicy");
const { BASIS_KEYS } = require("../../../services/centralCosting/engine");

const router = express.Router();
router.use(EmployeeAuthMiddleware);

/**
 * The company this actor is working in.
 *
 * From their own proven membership, exactly as Central Costing resolves it —
 * never from a body field. A policy written against a company somebody named
 * in a request is a policy written for whichever company they typed.
 */
async function requireCompany(req, res, next) {
  try {
    const requestedCompanyId = req.get("X-Costing-Company") || req.query?.actingCompanyId || null;
    const { companyId, membershipSource } = await resolveCompanyForActor(req.user, {
      requestedCompanyId,
      domainLabel: "Board policy",
      fail,
    });
    req.board = {
      companyId,
      membershipProven: membershipSource === MEMBERSHIP_SOURCES.MEMBERSHIP_RECORD,
      actorId: String(req.user?.id || req.user?._id || ""),
      actorName: String(req.user?.name || req.user?.email || ""),
    };
    next();
  } catch (err) {
    sendError(res, err);
  }
}

/** The caller's Board role, required at least to look. */
async function requireBoard(req, res, next) {
  try {
    const role = await boardRole(req);
    assertBoard(role, "read");
    req.board.role = role;
    req.board.can = {
      draft: canDo(role, "draft"),
      approve: canDo(role, "approve"),
    };
    next();
  } catch (err) {
    sendError(res, err);
  }
}

const policyKeyOf = (req) => {
  const key = String(req.params.policyKey || req.query.policyKey || "FINANCING").toUpperCase().trim();
  if (!POLICY_KEYS.includes(key)) {
    throw fail("VALIDATION", "That is not a Board policy this company keeps.", {
      field: "policyKey", allowed: [...POLICY_KEYS], value: key,
    });
  }
  return key;
};

/**
 * GET /access — may this caller reach the Board app at all, and as what?
 *
 * ── WHY THE SWITCHER NEEDS ITS OWN READ ─────────────────────────────────────
 * `/api/auth/verify` answers with department TILES and carries no roles, so a
 * switcher built from it can only know that somebody holds the Board
 * department — not that they hold a Board ROLE. Those are different facts, and
 * offering the app on the first one puts a tile in front of a person the app
 * will then refuse outright.
 *
 * The costing tile already solved this the same way, with its own small read
 * (`/api/costings/access`); this is that pattern, not a new one.
 *
 * ── AND IT IS NOT A GUARD ───────────────────────────────────────────────────
 * Nothing is authorised here. It answers a question a menu asks, and every act
 * inside Board re-checks `requireBoard` for itself. Deliberately NOT behind
 * `requireBoard`: a caller with no Board role must get an honest `false`
 * rather than a 403 the switcher would have to interpret.
 *
 * `company` is not required either — whether somebody is on the Board is not a
 * per-company question at this level, and demanding a company would make the
 * menu depend on which company a person happened to be standing in.
 */
router.get("/access", handle(async (req, res) => {
  const role = await boardRole(req);
  return res.json({
    success: true,
    /* ── WHAT THIS DOES AND DOES NOT SAY ──────────────────────────────────
       `allowed` is the whole answer: the Board grant AND an active Board role,
       both re-read from the database on this request. `role` is what that role
       is, so a screen can say "you are a viewer" rather than only "no".

       Nothing else. No policy, no company state, no other person. A menu asked
       a yes/no question and this is the yes/no. */
    allowed: Boolean(role),
    role: role || null,
    can: {
      read: canDo(role, "read"),
      draft: canDo(role, "draft"),
      approve: canDo(role, "approve"),
    },
  });
}));

/**
 * GET /vocabulary — the controlled answers, so the screen and the server
 * cannot drift into offering different ones.
 */
router.get("/vocabulary", requireCompany, requireBoard, handle(async (req, res) => res.json({
  success: true,
  policyKeys: [...POLICY_KEYS],
  bases: [...BASIS_KEYS],
  advanceTreatments: [...ADVANCE_TREATMENTS],
  /* The operational events the Board can measure financing from. */
  financingStartEvents: [...FINANCING_START_EVENTS],
  dayCountBases: [...DAY_COUNT_BASES],
  machineBurdenTreatments: [...MACHINE_BURDEN_TREATMENTS],
  gstTreatments: [...GST_TREATMENTS],
  developmentCalculations: [...DEVELOPMENT_CALCULATIONS],
  contingencyModes: [...CONTINGENCY_MODES],
  /* Not every basis: four of them contain the contingency line's own category,
     so a costing charged that way could not be calculated at all. The screen
     offers what the server will accept. */
  contingencyBases: [...boardPolicy.CONTINGENCY_BASES],
  role: req.board.role,
  can: req.board.can,
  departmentSlug: BOARD_DEPT_SLUG,
})));

/**
 * GET /:policyKey — the policy in force, every version, and what this reader
 * may do about it.
 *
 * History is the substance of the answer, not a supplementary tab. The
 * question a Board asks is what changed and when, and a screen that shows only
 * the current rate cannot answer it.
 */
router.get("/:policyKey", requireCompany, requireBoard, handle(async (req, res) => {
  const policyKey = policyKeyOf(req);
  const out = await boardPolicy.history(req.board, { policyKey });
  return res.json({
    success: true,
    companyId: String(req.board.companyId),
    role: req.board.role,
    can: req.board.can,
    ...out,
    /* What is still open on each draft, so the screen names it before somebody
       presses approve rather than after. The same function the approval
       itself checks — one rule, not two that can disagree. */
    gaps: Object.fromEntries(out.versions
      .filter((v) => v.status === "DRAFT")
      .map((v) => [String(v._id), boardPolicy.gapsFor(v)])),
  });
}));

/**
 * GET /:policyKey/legacy — what this company is still carrying on the retired
 * costing policy, offered as material for a first draft.
 *
 * Two policies have any. The charge catalogue retires a table whose KEYS
 * stored requirements point at, so it must be copied rather than retyped or
 * every requirement is orphaned. Contingency retires a rate and a basis that
 * are applied to every costing in the company, where a transcription slip in
 * retyping would be a company-wide error — so it is offered too, though for
 * convenience rather than necessity.
 *
 * The other four retired single values a Board can read off the costing screen
 * and type.
 *
 * Reading this changes nothing and approves nothing.
 */
router.get("/:policyKey/legacy", requireCompany, requireBoard, handle(async (req, res) => {
  const policyKey = policyKeyOf(req);
  if (policyKey === "DEVELOPMENT_CHARGE_POLICY") {
    const seed = await developmentChargePolicy.legacySeed(req.board);
    return res.json({ success: true, policyKey, available: seed.count > 0, ...seed });
  }
  if (policyKey === "CONTINGENCY_POLICY") {
    const seed = await contingencyPolicy.legacySeed(req.board);
    return res.json({ success: true, policyKey, ...seed });
  }
  if (policyKey === "MARGIN_POLICY") {
    const seed = await marginPolicy.legacySeed(req.board);
    return res.json({ success: true, policyKey, ...seed });
  }
  return res.json({ success: true, policyKey, available: false, source: null });
}));

/** POST /:policyKey/drafts — start a version. */
router.post("/:policyKey/drafts", requireCompany, requireBoard, handle(async (req, res) => {
  const policyKey = policyKeyOf(req);
  assertBoard(req.board.role, "draft");

  /* ── STARTING FROM SOMETHING THAT EXISTS ──────────────────────────────
     Two sources, and each is a copy the Board still has to approve:

       LEGACY_COSTING_POLICY  the retired table, so its keys survive;
       EFFECTIVE_VERSION      the catalogue in force, so amending one charge
                              does not mean retyping the other eleven — and
                              re-posting them from the client would be refused
                              as keys this new draft does not have.

     Anything else is ignored rather than guessed at: a draft seeded from a
     source nobody named would be content with no provenance. */
  let seed = null;
  let seededFrom = null;
  const seedFrom = String(req.body?.seedFrom || "");
  if (seedFrom === "LEGACY_COSTING_POLICY" && policyKey === "DEVELOPMENT_CHARGE_POLICY") {
    seed = (await developmentChargePolicy.legacySeed(req.board)).charges;
    seededFrom = "LEGACY_COSTING_POLICY";
  } else if (seedFrom === "LEGACY_COSTING_POLICY" && policyKey === "CONTINGENCY_POLICY") {
    const legacy = await contingencyPolicy.legacySeed(req.board);
    if (legacy.available) {
      seed = legacy.contingency;
      seededFrom = "LEGACY_COSTING_POLICY";
    }
  } else if (seedFrom === "LEGACY_COSTING_POLICY" && policyKey === "MARGIN_POLICY") {
    const legacy = await marginPolicy.legacySeed(req.board);
    if (legacy.available) {
      seed = legacy.margin;
      seededFrom = "LEGACY_COSTING_POLICY";
    }
  } else if (seedFrom === "EFFECTIVE_VERSION") {
    const inForce = await boardPolicy.resolveEffective(req.board.companyId, policyKey);
    if (inForce) {
      seed = inForce[BOARD_PAYLOAD_FIELD[policyKey]];
      seededFrom = "EFFECTIVE_VERSION";
    }
  }

  const doc = await boardPolicy.createDraft(req.board, {
    policyKey,
    ...(seed ? { seed, seededFrom } : {}),
    /* Each policy's own payload field, by name — the service reads only the
       one its key owns, so a body carrying another's writes nothing of it. */
    financing: req.body?.financing || {},
    overhead: req.body?.overhead || {},
    labour: req.body?.labour || {},
    gst: req.body?.gst || {},
    contingency: req.body?.contingency || {},
    margin: req.body?.margin || {},
    /* A LIST, like the development catalogue: anything that is not an array
       reads as "not sent" and leaves the stored table alone. */
    dutyRules: Array.isArray(req.body?.dutyRules) ? req.body.dutyRules : undefined,
    /* A LIST, not an object like the four above — the charge catalogue is
       many charges, and the contract reads anything that is not an array as
       "not sent" rather than as an empty catalogue. */
    developmentCharges: Array.isArray(req.body?.developmentCharges)
      ? req.body.developmentCharges : undefined,
    rationale: req.body?.rationale || "",
    effectiveFrom: req.body?.effectiveFrom || null,
  });
  return res.status(201).json({ success: true, version: doc });
}));

/** PUT /:policyKey/drafts/:id — change one. Only while it is a draft. */
router.put("/:policyKey/drafts/:id", requireCompany, requireBoard, handle(async (req, res) => {
  policyKeyOf(req);
  assertBoard(req.board.role, "draft");
  const doc = await boardPolicy.updateDraft(req.board, req.params.id, req.body || {});
  return res.json({
    success: true,
    version: doc,
    gaps: boardPolicy.gapsFor(doc),
  });
}));

/**
 * POST /:policyKey/drafts/:id/approve — put it in force from a date.
 *
 * A separate act with its own rank on purpose. A policy whose author is always
 * its approver has a review step in name only.
 */
router.post("/:policyKey/drafts/:id/approve", requireCompany, requireBoard, handle(async (req, res) => {
  policyKeyOf(req);
  assertBoard(req.board.role, "approve");
  const doc = await boardPolicy.approve(req.board, req.params.id, {
    effectiveFrom: req.body?.effectiveFrom || null,
  });
  return res.json({ success: true, version: doc });
}));

/** DELETE /:policyKey/drafts/:id — discard a draft. Never an approved one. */
router.delete("/:policyKey/drafts/:id", requireCompany, requireBoard, handle(async (req, res) => {
  policyKeyOf(req);
  assertBoard(req.board.role, "draft");
  const out = await boardPolicy.discardDraft(req.board, req.params.id);
  return res.json({ success: true, ...out });
}));

module.exports = router;
