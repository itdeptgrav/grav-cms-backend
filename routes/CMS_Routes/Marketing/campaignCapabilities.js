// routes/CMS_Routes/Marketing/campaignCapabilities.js
//   → mounted at /api/cms/marketing
//
// WHAT A CAMPAIGN BUILDER IS ALLOWED TO ASK FOR.
//
//   GET /campaign-capabilities                     everything, for the builder
//   GET /campaign-capabilities/:campaignType       one type's column
//
// ── WHY THIS IS A ROUTE AND NOT A CONSTANTS FILE IN THE FRONTEND ───────────
// Because the answer changes when the backend changes, and a copy in the
// frontend would go stale silently. A field that GRAV stopped supporting would
// keep rendering; a field it started supporting would stay hidden until
// somebody noticed. The builder reads the matrix at runtime so the two cannot
// disagree.
//
// ── IT DESCRIBES; IT DOES NOT PERMIT ───────────────────────────────────────
// Nothing here creates, validates or approves anything. A campaign type marked
// deployable in this response is still subject to every existing check —
// readiness, preflight, targeting resolution, the binding, the approval — and
// a type marked not deployable is refused by those contracts regardless of
// what a caller does with this response.
//
// ── AND NOTHING HERE CAN START A CAMPAIGN ──────────────────────────────────
// `deliveryBoundary` is published on every response, saying so: GRAV creates
// campaigns stopped and offers no control that starts one. The lifecycle
// states that spend money are declared with `offersControl: false`.
"use strict";

/* The controlled-creation list and the lead-form vocabulary, for non-deployable
   types that are nonetheless partly built. */
const readinessTypes = require("../../../constants/marketingDeploymentReadiness");
const { LEAD_FORM_VOCABULARY } = require("../../../constants/marketingGoogleLeadForm");

const express = require("express");

const router = express.Router();

const marketingAuth = require("../../../Middlewear/MarketingAuthMiddlewear");
const { fail } = require("../../../services/storePurchase/errors");
const providerPrivacy = require("../../../services/marketing/providerPrivacy");

const sendError = (res, err) => providerPrivacy.sendMarketingError(res, err);
const handle = providerPrivacy.handleMarketing({ surface: "marketing" });

const caps = require("../../../constants/marketingCampaignCapabilities");

const str = (v) => String(v ?? "").trim();

router.use(marketingAuth);

/* ── ONE SETTING, AS A BUILDER NEEDS IT ─────────────────────────────────────
   The setting's own meaning and the support state together, so a screen has
   the label, the explanation and the reason in one object and never has to
   join two lists. */
function settingView(campaignType, code) {
  const spec = caps.SETTING_BY_CODE[code];
  const cap = caps.capabilityFor(campaignType, code);
  if (!spec || !cap) return null;

  const support = caps.SUPPORT_BY_CODE[cap.support];
  return {
    code: spec.code,
    label: spec.label,
    section: spec.section,
    means: spec.means,
    support: cap.support,
    supportLabel: support.label,
    supportMeans: support.means,
    /* Whether a builder may render an input for it. */
    settable: support.settable,
    /* Whether a plan is refused without it. */
    required: cap.support === "required",
    /* Present on everything that is not plainly supported. A disabled field
       with no reason is the thing a marketer escalates. */
    why: cap.why || null,
  };
}

function typeView(code) {
  const type = caps.CAMPAIGN_TYPE_BY_CODE[code];
  if (!type) return null;

  const base = {
    campaignType: type.code,
    label: type.label,
    channel: type.channel,
    /* What the advertising interface calls it, beside what GRAV calls it — a
       marketer reconciles the two screens. */
    channelTerm: type.channelTerm,
    means: type.means,
    deployable: type.deployable === true,
    /* How this type reaches people, which is the thing that decides whether a
       targeting setting makes sense at all. */
    audienceModel: type.audienceModel || null,
    audienceMeans: type.audienceMeans || null,
  };

  if (!type.deployable) {
    /* ── NO SETTINGS COLUMN FOR A TYPE NOBODY CAN CREATE ─────────────────
       Publishing one would describe a form that leads nowhere. What it gets
       instead is the reason and the list of what is missing, so a builder can
       show it greyed and honest rather than hiding it and leaving somebody to
       wonder whether GRAV can do it at all. */
    const controlled = readinessTypes.CONTROLLED_CAMPAIGN_TYPES.find((t) => t.code === type.code) || null;
    return {
      ...base,
      blockedBy: type.blockedBy,
      needs: type.needs || [],
      /* What IS done, so a type that is not offered does not read as absent. */
      localContract: type.localContract || null,
      /* Whether an administrator can create it in the proof account today. */
      controlledCreation: controlled
        ? { available: true, means: controlled.controlledMeans }
        : { available: false, means: null },
      /* The type whose settings column this brief uses, and the bidding it
         must choose — explicit, so a builder never infers either. */
      settingsFrom: controlled?.settingsFrom || null,
      requiredBiddingStrategy: controlled?.requiredBiddingStrategy || null,
      ...(type.code === "google_lead_form" ? { leadFormVocabulary: LEAD_FORM_VOCABULARY } : {}),
      sections: [],
      settings: [],
    };
  }

  const settings = caps.SETTING_CODES
    .map((c) => settingView(type.code, c))
    .filter(Boolean);

  return {
    ...base,
    blockedBy: null,
    needs: [],
    /* Grouped for the builder's steps, and ordered by them. */
    sections: caps.SECTIONS
      .filter((sec) => settings.some((s) => s.section === sec.code))
      .map((sec) => ({
        code: sec.code,
        label: sec.label,
        step: sec.step,
        means: sec.means,
        settings: settings.filter((s) => s.section === sec.code).map((s) => s.code),
      })),
    settings,
    summary: {
      required: caps.settingsBySupport(type.code, "required"),
      supported: caps.settingsBySupport(type.code, "supported"),
      notModelled: caps.settingsBySupport(type.code, "not_modelled"),
      unavailable: caps.settingsBySupport(type.code, "unavailable"),
      requiresExternalAudience: caps.settingsBySupport(type.code, "requires_external_audience"),
      externallyVerified: caps.settingsBySupport(type.code, "externally_verified"),
    },
  };
}

const lifecycleView = () => caps.LIFECYCLE.map((l) => ({
  code: l.code,
  label: l.label,
  order: l.order,
  means: l.means,
  reachable: l.reachable,
  /* ── THE FIELD THAT KEEPS ACTIVATION OUT OF THE INTERFACE ─────────────
     A builder may draw the whole sequence — showing somebody where a campaign
     sits in a process is useful — but it must not offer a control for a state
     nothing can reach. */
  offersControl: l.offersControl,
  terminal: l.terminal === true,
  blockedBy: l.blockedBy || null,
}));

/**
 * GET /campaign-capabilities
 *
 * Everything a multi-step builder needs: the steps, the setting vocabulary,
 * every campaign type with its own column, the lifecycle, the reads that exist
 * today and the ones that do not.
 */
router.get("/campaign-capabilities", handle(async (req, res) => {
  if (Object.keys(req.query || {}).length) {
    throw fail("VALIDATION", "The capability matrix takes no parameters.",
      { unknown: Object.keys(req.query) });
  }

  return res.json({
    success: true,

    /* The builder's steps, in order. */
    steps: caps.SECTIONS.map((s) => ({ code: s.code, label: s.label, step: s.step, means: s.means })),

    /* What each support state means, so a screen renders one legend rather
       than hard-coding six strings. */
    supportStates: caps.SUPPORT.map((s) => ({
      code: s.code, label: s.label, means: s.means, settable: s.settable, blocksCreation: s.blocksCreation,
    })),

    campaignTypes: caps.CAMPAIGN_TYPE_CODES.map(typeView),
    deployableCampaignTypes: caps.DEPLOYABLE_CAMPAIGN_TYPES,

    lifecycle: lifecycleView(),
    deliveryBoundary: caps.DELIVERY_BOUNDARY,

    managementReads: caps.MANAGEMENT_READS.map((r) => ({
      code: r.code, label: r.label, available: r.available,
      servedBy: r.servedBy || null, blockedBy: r.blockedBy || null, caveat: r.caveat || null,
    })),

    /* Declared so the contract can be judged against what it will have to
       support. Nothing here is implemented and no model is called. */
    intelligenceReadiness: caps.INTELLIGENCE_READINESS.map((i) => ({
      code: i.code, label: i.label,
      needsEvidence: i.needsEvidence,
      requiresHumanApproval: i.requiresHumanApproval,
      blockedBy: i.blockedBy || null,
    })),
    intelligenceRules: caps.INTELLIGENCE_RULES,

    means: "What each campaign type can and cannot do. Read this to build the campaign form; a setting missing from a type's column is one that type cannot carry.",
  });
}));

/** GET /campaign-capabilities/:campaignType — one column. */
router.get("/campaign-capabilities/:campaignType", handle(async (req, res) => {
  const code = str(req.params.campaignType);
  const view = typeView(code);

  if (!view) {
    throw fail("VALIDATION",
      `GRAV has no campaign type called "${code}". It knows: ${caps.CAMPAIGN_TYPE_CODES.join(", ")}.`,
      { field: "campaignType", known: caps.CAMPAIGN_TYPE_CODES });
  }

  return res.json({
    success: true,
    ...view,
    supportStates: caps.SUPPORT.map((s) => ({
      code: s.code, label: s.label, means: s.means, settable: s.settable, blocksCreation: s.blocksCreation,
    })),
    lifecycle: lifecycleView(),
    deliveryBoundary: caps.DELIVERY_BOUNDARY,
  });
}));

router.use((err, req, res, _next) => sendError(res, err));

module.exports = router;
