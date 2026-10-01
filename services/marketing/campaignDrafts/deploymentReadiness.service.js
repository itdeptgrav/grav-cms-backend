// services/marketing/campaignDrafts/deploymentReadiness.service.js
//
// WHETHER A CAMPAIGN PLAN COULD BE PREPARED FOR DEPLOYMENT, AND WHAT IS MISSING.
//
// ── THIS FILE TALKS TO NOTHING ─────────────────────────────────────────────
// It takes a plan snapshot and returns a verdict. No provider adapter, no HTTP
// client, no database read, no database write. That is not incidental: a readiness
// evaluator that could reach a provider would, sooner or later, be the thing that
// created a campaign while answering a question. A test reads this file's source
// and fails if it requires any provider client or `axios`.
//
// It is also PURE in the sense that matters for a readiness answer: the same
// snapshot produces the same findings in the same order, every time. A verdict that
// varied would be impossible to act on — a marketer would fix two things and see
// three new ones.
//
// ── WHAT THE THREE VERDICTS MEAN, AND WHAT THEY DO NOT ─────────────────────
//
//   planReady        the GRAV document holds the planning information GRAV needs
//   approvalReady    it is complete enough to put in front of an approver
//   deploymentReady  ALWAYS FALSE in this chunk
//
// The third one is the important one. `deploymentReady` cannot be true here even
// for a perfect, approved plan, because every external condition is unchecked:
// nobody has asked whether the advertising account is reachable, whether its
// currency matches, whether the content still exists, whether the channel's policy
// permits the creative, whether the mapped objects validate, or whether each object
// can be created already paused. Those answers belong to authorities GRAV has not
// consulted, and claiming them would be the single most expensive lie this code
// could tell.
//
// ── AND APPROVAL STILL MEANS WHAT IT MEANT ─────────────────────────────────
// Nothing in a readiness response may imply that approval created a campaign,
// committed money, activated delivery, or confirmed that a provider accepted or
// paused anything. Every sentence here is written with that in mind, and the
// response carries an explicit statement of it.
"use strict";

const {
  EVALUATOR_VERSION, SUPPORTED_CAMPAIGN_TYPES, CHANNEL_SUPPORT, BIDDING_STRATEGIES,
  BUDGET_RELATIONSHIPS, DESTINATION_KINDS, EXCLUSION_DECISIONS, FINDING_SEVERITIES,
  FINDING_GROUPS, FINDING_CODES, GOAL_COMPATIBILITY, BRIEF_LIMITS,
  campaignType: typeSpec, biddingStrategy: biddingSpec,
  budgetRelationship: relationshipSpec, destinationKind: destinationSpec,
  exclusionDecision: exclusionSpec,
} = require("../../../constants/marketingDeploymentReadiness");
const { MARKETING_CHANNELS, channel: channelSpec } = require("../../../constants/marketingChannels");
/* Pure: constants in, verdict out. The same judgement preflight makes, so the
   builder, submission, approval and creation cannot disagree about a form. */
const leadFormDefinition = require("../deployment/googleLeadFormDefinition");

const str = (v) => String(v ?? "").trim();
const list = (v) => (Array.isArray(v) ? v : []);

/* ── A SUPPLIED NUMBER IS A NUMBER, NOT SOMETHING NUMBER() ACCEPTS ───────────
   `Number(null)` is 0, `Number("")` is 0, `Number(false)` is 0 and `Number("0")`
   is 0. Using `Number.isFinite(Number(x))` therefore treated four different
   absences as a supplied zero — the exact collapse the whole plan contract is
   written to prevent, reintroduced inside the thing that judges it.

   Strict, and matching the write boundary: only a finite JSON number counts. A
   legacy snapshot or a document written before that boundary existed can hold any
   of the others, which is why this is checked here and not left to validation on
   the way in. */
const isSuppliedNumber = (v) => typeof v === "number" && Number.isFinite(v);

/* The same for text. `str()` would turn `false` into "false" and a number into its
   digits, both of which would read as a supplied value. */
const isSuppliedText = (v) => typeof v === "string" && v.trim().length > 0;

/**
 * One finding.
 *
 * Every field is required because a finding missing any of them is a finding
 * somebody cannot act on: a code with no corrective action is a dead end, and a
 * title with no field is a hunt.
 */
const finding = ({ code, group, severity, channel, field, title, explanation, action }) => ({
  code,
  group,
  severity,
  /* Null for a plan-level finding that belongs to no single channel. */
  channel: channel || null,
  field: field || null,
  title,
  explanation,
  suggestedAction: action,
});

const blocking = (args) => finding({ ...args, severity: "blocking" });
const advisory = (args) => finding({ ...args, severity: "advisory" });

/* ── THE EXTERNAL CHECKS, WRITTEN ONCE ───────────────────────────────────────
   Each names the authority that would have to answer it. They are returned for
   every advertising channel on the plan, always, because none of them has been
   asked — and a list that shrank as the plan improved would suggest some had. */
const EXTERNAL_CHECKS = [
  {
    code: FINDING_CODES.EXTERNAL_ACCOUNT_ACCESS,
    title: "Advertising account access is not confirmed",
    explanation: "GRAV has not checked that it can currently reach this channel's advertising account. Access can be revoked at any time, so a check that passed yesterday proves nothing today.",
    action: "A later preflight step will read the account before anything is created.",
    authority: "the advertising channel",
  },
  {
    code: FINDING_CODES.EXTERNAL_ACCOUNT_CURRENCY,
    title: "The account's currency is not confirmed",
    explanation: "The plan's budget currency has not been compared with the advertising account's own. A mismatch is a budget error of a hundredfold that both sides consider valid.",
    action: "A later preflight step will read the account currency and refuse a mismatch.",
    authority: "the advertising channel",
  },
  {
    code: FINDING_CODES.EXTERNAL_CONTENT_USABLE,
    title: "Referenced content is not confirmed to still exist",
    explanation: "The plan names content by identifier. GRAV has not asked the content library whether each item still exists and is usable; a captured name is what it was called when it was chosen, not proof it is still there.",
    action: "A later preflight step will resolve every content reference against the library.",
    authority: "the content library",
  },
  {
    code: FINDING_CODES.EXTERNAL_POLICY_COMPATIBLE,
    title: "Channel policy compatibility is not confirmed",
    explanation: "Advertising copy and imagery are reviewed by the channel against its own policies, which GRAV cannot evaluate and which change without notice.",
    /* The earlier wording promised WHEN the channel would decide — after creation,
       while still paused. GRAV has never verified that sequence, and a promise about
       somebody else's review process is not GRAV's to make. */
    action: "Policy compatibility can only be established by an external check against the channel. GRAV cannot confirm it locally.",
    authority: "the advertising channel",
  },
  {
    code: FINDING_CODES.EXTERNAL_MAPPED_OBJECT_VALID,
    title: "The mapped campaign objects are not validated",
    explanation: "GRAV has not built the channel-shaped objects this plan would become, so nothing has confirmed that the channel would accept them.",
    action: "A later preflight step will build and validate every object before creating any.",
    authority: "the advertising channel",
  },
  {
    code: FINDING_CODES.EXTERNAL_PAUSED_CREATION_POSSIBLE,
    title: "Creating everything already paused is not confirmed",
    explanation: "Nothing has confirmed that every object this campaign needs can be created in a paused state and read back as paused. Until that is proved, GRAV will not create any of them.",
    action: "A later preflight step will confirm the paused-creation path for each object.",
    authority: "the advertising channel",
  },
];

const externalFinding = (spec, channel) => finding({
  code: spec.code,
  group: "external_check_required",
  /* Blocking for DEPLOYMENT readiness and irrelevant to plan readiness. Severity
     describes the finding, and which verdict it affects is decided below. */
  severity: "blocking",
  channel,
  field: null,
  title: spec.title,
  explanation: spec.explanation,
  action: spec.action,
});

/* ═══ PER-CHANNEL EVALUATION ═════════════════════════════════════════════════ */

/**
 * Evaluate one channel's brief.
 *
 * Returns every finding for that channel. Order is fixed by the order of the checks
 * below, so identical snapshots produce identical output.
 */
function evaluateChannel({ plan, channel, brief }) {
  const out = [];
  const spec = channelSpec(channel);
  const support = CHANNEL_SUPPORT[channel];

  /* ── A CHANNEL THAT PUBLISHES NO ADVERTISEMENTS ─────────────────────────────
     `email` and `google_analytics` are on the plan's channel list for good
     reasons, and neither takes an advertising campaign. This is not "unsupported
     campaign type" — there is no campaign type to support — and saying so with the
     wrong words would send somebody looking for a setting that does not exist. */
  if (!support) {
    out.push(advisory({
      code: FINDING_CODES.CHANNEL_NOT_A_PUBLISHER,
      /* Its own group: this is information about the channel, not an unsupported
         choice somebody made. */
      group: "not_applicable",
      channel,
      field: "channels",
      title: `${spec?.label || channel} does not carry advertising campaigns`,
      explanation: spec?.role === "measurement"
        ? `${spec.label} measures activity. Nothing is published through it, so it needs no campaign brief.`
        : `${spec?.label || channel} is operated by GRAV itself and has no advertising campaign to prepare.`,
      action: "No action. This channel is simply not part of advertising deployment.",
    }));
    return out;
  }

  if (!brief) {
    out.push(blocking({
      code: FINDING_CODES.BRIEF_MISSING,
      group: "missing_from_plan",
      channel,
      field: "deploymentBriefs",
      title: `There is no ${spec.label} brief`,
      explanation: `This plan selects ${spec.label} but records none of the decisions a ${spec.label} campaign needs.`,
      action: `Add a ${spec.label} brief to the plan.`,
    }));
    return out;
  }

  /* ── THE CAMPAIGN TYPE DECIDES WHICH CHECKS APPLY ──────────────────────────── */
  const wantedType = str(brief.campaignType);
  if (!wantedType) {
    out.push(blocking({
      code: FINDING_CODES.CAMPAIGN_TYPE_MISSING,
      group: "missing_from_plan",
      channel,
      field: "campaignType",
      title: "No campaign type is chosen",
      explanation: `GRAV prepares one kind of ${spec.label} campaign, and the plan has not said it wants that one.`,
      action: `Choose ${SUPPORTED_CAMPAIGN_TYPES.filter((t) => t.channel === channel).map((t) => t.label).join(" or ")}.`,
    }));
    return out;
  }

  const type = typeSpec(wantedType);
  if (!type) {
    out.push(blocking({
      code: FINDING_CODES.CAMPAIGN_TYPE_UNSUPPORTED,
      group: "unsupported_by_grav",
      channel,
      field: "campaignType",
      title: "GRAV does not prepare that campaign type yet",
      explanation: `GRAV prepares only ${SUPPORTED_CAMPAIGN_TYPES.filter((t) => t.channel === channel).map((t) => t.label).join(" or ")} for ${spec.label}. It will not approximate a different type as one of those, because the result would be a campaign that does not do what the plan says.`,
      action: "Choose a supported campaign type, or wait for GRAV to add this one.",
    }));
    return out;
  }
  if (type.channel !== channel) {
    out.push(blocking({
      code: FINDING_CODES.CAMPAIGN_TYPE_WRONG_CHANNEL,
      group: "contradiction",
      channel,
      field: "campaignType",
      title: "That campaign type belongs to a different channel",
      explanation: `${type.label} is a ${channelSpec(type.channel)?.label || type.channel} campaign type, and this brief is for ${spec.label}.`,
      action: `Choose a ${spec.label} campaign type.`,
    }));
    return out;
  }

  const needs = new Set(type.requires);

  /* ── DESTINATION ──────────────────────────────────────────────────────────── */
  if (needs.has("destination")) {
    const destination = brief.destination;
    const kind = destinationSpec(str(destination?.kind));
    if (!destination || !kind) {
      out.push(blocking({
        code: FINDING_CODES.DESTINATION_MISSING,
        group: "missing_from_plan",
        channel,
        field: "destination",
        title: "There is nowhere for a click to go",
        explanation: "An advertisement with no destination cannot be approved by the channel, and nobody clicking it would arrive anywhere.",
        action: `Choose ${DESTINATION_KINDS.map((d) => d.label.toLowerCase()).join(" or ")}.`,
      }));
    } else if (kind.needsContentRef && !isSuppliedText(destination.contentId)) {
      out.push(blocking({
        code: FINDING_CODES.DESTINATION_CONTENT_MISSING,
        group: "missing_from_plan",
        channel,
        field: "destination.contentId",
        title: "The landing page is not identified",
        explanation: "The destination is a landing page from the content library, and the plan does not say which one.",
        action: "Pick the landing page from the content library.",
      }));
    } else if (!kind.needsContentRef && !isSuppliedText(destination.url)) {
      out.push(blocking({
        code: FINDING_CODES.DESTINATION_MISSING,
        group: "missing_from_plan",
        channel,
        field: "destination.url",
        title: "The destination address is missing",
        explanation: "The destination is a page on the company website, and no address is recorded.",
        action: "Add the page address.",
      }));
    }
  }

  /* ── TARGETING ────────────────────────────────────────────────────────────── */
  if (needs.has("geoTargeting") && !list(brief.geoTargeting).length) {
    out.push(blocking({
      code: FINDING_CODES.GEO_TARGETING_MISSING,
      group: "missing_from_plan",
      channel,
      field: "geoTargeting",
      title: "No places are targeted",
      explanation: "A campaign with no geographic targeting either reaches everywhere the channel can reach, or is refused. Neither is a decision somebody made.",
      action: "Name the countries, regions or cities this campaign is for.",
    }));
  }

  if (needs.has("languages") && !list(brief.languages).filter(isSuppliedText).length) {
    out.push(blocking({
      code: FINDING_CODES.LANGUAGES_MISSING,
      group: "missing_from_plan",
      channel,
      field: "languages",
      title: "No languages are chosen",
      explanation: "The channel decides who sees an advertisement partly by the language they browse in, and its default is not a choice this plan made.",
      action: "Name the languages this campaign's audience reads.",
    }));
  }

  /* ── THE EXCLUSION DECISION ───────────────────────────────────────────────── */
  if (needs.has("exclusions")) {
    const decision = exclusionSpec(str(brief.exclusionDecision));
    if (!decision || !decision.decided) {
      out.push(blocking({
        code: FINDING_CODES.EXCLUSION_DECISION_MISSING,
        group: "missing_from_plan",
        channel,
        field: "exclusionDecision",
        title: "Nobody has decided about exclusions",
        explanation: "Advertising appearing beside content a company would not sponsor happens because nobody decided. Recording that no exclusions are needed is a decision; leaving it blank is not.",
        action: "Record either that no exclusions apply, or which ones do.",
      }));
    } else if (decision.code === "listed" && !list(brief.exclusions).length) {
      out.push(blocking({
        code: FINDING_CODES.EXCLUSION_DECISION_MISSING,
        group: "contradiction",
        channel,
        field: "exclusions",
        title: "Exclusions are said to be listed, and none are",
        explanation: "The plan records that exclusions apply but names none.",
        action: "List the exclusions, or record that none are needed.",
      }));
    }
  }

  /* ── BIDDING ──────────────────────────────────────────────────────────────── */
  if (needs.has("bidding")) {
    const bidding = brief.bidding;
    const strategy = biddingSpec(str(bidding?.strategy));
    if (!strategy) {
      out.push(blocking({
        code: FINDING_CODES.BIDDING_MISSING,
        group: "missing_from_plan",
        channel,
        field: "bidding.strategy",
        title: "No bidding strategy is chosen",
        explanation: "The channel will not create a campaign without one, and its default decides how the budget is spent. That is not something to leave to a default.",
        action: `Choose ${BIDDING_STRATEGIES.map((b) => b.label.toLowerCase()).join(", ")}.`,
      }));
    } else {
      /* Strict on both halves: a target of `"40"` is a client bug worth surfacing,
         and a currency of `false` is not a currency. */
      if (strategy.needsTarget
        && !(isSuppliedNumber(bidding?.target?.amount) && isSuppliedText(bidding?.target?.currency))) {
        out.push(blocking({
          code: FINDING_CODES.BIDDING_TARGET_MISSING,
          group: "missing_from_plan",
          channel,
          field: "bidding.target",
          title: `${strategy.targetLabel} is not set`,
          explanation: `${strategy.label} aims for a figure, and the plan does not give one with its currency. A target without a currency is not a target.`,
          action: `Set ${strategy.targetLabel.toLowerCase()} with its currency.`,
        }));
      }
      /* A strategy that optimises towards conversions needs a conversion the channel
         can actually see. GRAV's own outcomes are not visible to the channel, so
         pairing them is a contradiction rather than a gap. */
      if (strategy.code === "target_cost_per_action"
        && ["qualified_prospect", "sales_handover"].includes(str(plan.conversionGoal))) {
        out.push(blocking({
          code: FINDING_CODES.BIDDING_NEEDS_CONVERSION_GOAL,
          group: "contradiction",
          channel,
          field: "bidding.strategy",
          title: "The channel cannot optimise towards this goal",
          explanation: "Target cost per action asks the channel to optimise towards conversions it can see. This plan's goal is a GRAV business outcome the channel is never told about, so it cannot be optimised for.",
          action: "Either choose a goal the channel can measure, or choose a bidding strategy that does not optimise towards conversions.",
        }));
      }
    }
  }

  /* ── CREATIVE ─────────────────────────────────────────────────────────────── */
  if (needs.has("creative")) {
    /* A lead-form campaign is a Search campaign with a form attached: it still
       needs the advertisement and the search terms. */
    if (type.code === "google_search" || type.code === "google_lead_form") {
      const creative = brief.googleSearch || {};
      /* A headline of `0` or `false` is not a headline. */
      const headlines = list(creative.headlines).filter(isSuppliedText);
      const descriptions = list(creative.descriptions).filter(isSuppliedText);
      if (headlines.length < BRIEF_LIMITS.GOOGLE_HEADLINES_MIN
        || descriptions.length < BRIEF_LIMITS.GOOGLE_DESCRIPTIONS_MIN) {
        out.push(blocking({
          code: FINDING_CODES.CREATIVE_INCOMPLETE,
          group: "missing_from_plan",
          channel,
          field: "googleSearch",
          title: "The advertisement text is incomplete",
          explanation: `A Search advertisement needs at least ${BRIEF_LIMITS.GOOGLE_HEADLINES_MIN} headlines and ${BRIEF_LIMITS.GOOGLE_DESCRIPTIONS_MIN} descriptions. This plan has ${headlines.length} and ${descriptions.length}.`,
          action: "Write the remaining headlines and descriptions.",
        }));
      }
      if (!list(creative.keywordThemes).filter(isSuppliedText).length) {
        out.push(blocking({
          code: FINDING_CODES.CREATIVE_INCOMPLETE,
          group: "missing_from_plan",
          channel,
          field: "googleSearch.keywordThemes",
          title: "No search terms are named",
          explanation: "A Search campaign appears for the terms somebody chose. With none, the channel either refuses the campaign or decides for itself.",
          action: "Name the search terms this campaign should appear for.",
        }));
      }
    }

    if (type.code === "meta_traffic_single_image") {
      const creative = brief.metaSingleImage || {};
      const missing = [];
      if (!isSuppliedText(creative.primaryText)) missing.push("the main text");
      if (!isSuppliedText(creative.headline)) missing.push("a headline");
      if (!isSuppliedText(creative.callToAction)) missing.push("a call to action");
      if (missing.length) {
        out.push(blocking({
          code: FINDING_CODES.CREATIVE_INCOMPLETE,
          group: "missing_from_plan",
          channel,
          field: "metaSingleImage",
          title: "The advertisement is incomplete",
          explanation: `A single-image advertisement needs ${missing.join(", ")}.`,
          action: "Write the missing parts of the advertisement.",
        }));
      }
    }
  }

  /* ── MEDIA ────────────────────────────────────────────────────────────────── */
  if (needs.has("media")) {
    const image = brief.metaSingleImage?.image || {};
    if (!isSuppliedText(image.contentId)) {
      out.push(blocking({
        code: FINDING_CODES.MEDIA_REFERENCE_MISSING,
        group: "missing_from_plan",
        channel,
        field: "metaSingleImage.image",
        title: "No image is identified",
        explanation: "A single-image advertisement is an image and some words. The plan names no image.",
        action: "Identify the image this advertisement should use.",
      }));
    } else {
      /* ── THE HONEST GAP ───────────────────────────────────────────────────
         GRAV's content library holds emails, forms and landing pages. It does not
         hold an advertising media kind, so GRAV cannot resolve this reference and
         must not claim it did. Recorded as an external check rather than a local
         confirmation. */
      out.push(externalFinding({
        code: FINDING_CODES.EXTERNAL_MEDIA_USABLE,
        title: "The advertisement image cannot be confirmed yet",
        explanation: "GRAV's content library holds emails, forms and landing pages. It does not yet hold advertising images, so GRAV cannot confirm that this image exists or that the channel would accept its size and format.",
        action: "A later step will add advertising media to the content library and resolve this reference.",
      }, channel));
    }
  }

  /* ── THE LEAD FORM ────────────────────────────────────────────────────────
     Judged by the one definition evaluator, at plan scope: the account is
     preflight's question. The goal is judged below by GOAL_COMPATIBILITY, so the
     evaluator's own goal check is not repeated here; its external checks belong
     to preflight too. */
  if (needs.has("leadForm")) {
    const verdict = leadFormDefinition.evaluate({
      form: brief.googleLeadForm, brief, plan, scope: "plan",
    });
    for (const c of verdict.blocking.filter((x) => x.code !== "lead_form_conversion_goal")) {
      out.push(blocking({
        code: FINDING_CODES.LEAD_FORM_INCOMPLETE,
        group: c.code === "conversion_bidding" ? "contradiction" : "missing_from_plan",
        channel,
        field: c.code === "conversion_bidding" ? "bidding.strategy" : `googleLeadForm.${c.code}`,
        title: c.code === "conversion_bidding"
          ? "A lead form needs bidding towards conversions"
          : "The lead form is not complete",
        explanation: c.means,
        action: c.code === "conversion_bidding"
          ? "Choose Target cost per action."
          : "Complete the lead form.",
      }));
    }
  }

  /* ── CREATED ONLY UNDER CONTROL ───────────────────────────────────────────
     Said on every plan of a controlled type, as advice rather than a block: the
     plan can be written, submitted and approved; creating it is limited to the
     proof account until the type has been proven. */
  if (type.controlled === true) {
    out.push(advisory({
      code: FINDING_CODES.LEAD_FORM_CONTROLLED_ONLY,
      group: "unsupported_by_grav",
      channel,
      field: "campaignType",
      title: "Created only in the proof account for now",
      explanation: type.controlledMeans,
      action: "No action on the plan. An administrator runs the creation in the proof account.",
    }));
  }

  /* ── THE CONVERSION GOAL, AGAINST WHAT THIS TYPE CAN PURSUE ───────────────── */
  if (needs.has("conversionGoal")) {
    const goal = isSuppliedText(plan.conversionGoal) ? plan.conversionGoal.trim() : "";
    if (!goal) {
      out.push(blocking({
        code: FINDING_CODES.CONVERSION_GOAL_MISSING,
        group: "missing_from_plan",
        channel,
        field: "conversionGoal",
        title: "The plan has no conversion goal",
        explanation: "A campaign is judged by something agreed before the spending, not chosen afterwards from whatever looks best.",
        action: "Choose the conversion goal for this campaign.",
      }));
    } else {
      const allowed = GOAL_COMPATIBILITY[type.code] || [];
      if (!allowed.includes(goal)) {
        out.push(blocking({
          code: FINDING_CODES.CONVERSION_GOAL_INCOMPATIBLE,
          group: "contradiction",
          channel,
          field: "conversionGoal",
          title: "This goal cannot be pursued by this campaign type",
          explanation: `A ${type.label.toLowerCase()} cannot honestly pursue that goal. GRAV will not map it onto a different one, because the campaign would then be optimising for something nobody agreed to.`,
          action: `Choose a goal this campaign type can pursue, or a campaign type that can pursue this goal.`,
        }));
      }
    }
  }

  /* ── BUDGET RELATIONSHIP ──────────────────────────────────────────────────── */
  const relationship = relationshipSpec(str(brief.budgetRelationship));
  if (!relationship) {
    out.push(blocking({
      code: FINDING_CODES.BUDGET_RELATIONSHIP_MISSING,
      group: "missing_from_plan",
      channel,
      field: "budgetRelationship",
      title: "It is not clear what the budget governs",
      explanation: "The plan records an amount but not whether it is the campaign's whole spend, a daily rate, or a daily rate per audience. Those differ by an order of magnitude.",
      action: "Say what the budget figure governs.",
    }));
  } else {
    if (relationship.channels && !relationship.channels.includes(channel)) {
      out.push(blocking({
        code: FINDING_CODES.BUDGET_RELATIONSHIP_WRONG_CHANNEL,
        group: "unsupported_by_grav",
        channel,
        field: "budgetRelationship",
        title: `${channelSpec(channel)?.label || channel} does not support that budget arrangement`,
        explanation: `${relationship.label} is available on ${relationship.channels.map((c) => channelSpec(c)?.label || c).join(", ")} only.`,
        action: "Choose a budget arrangement this channel supports.",
      }));
    }
    /* The plan's basis and the brief's relationship have to agree. A total budget
       described as a daily rate is a thirtyfold error that both values look fine
       on their own. */
    const basis = str(plan.budget?.basis);
    if (basis === "total" && relationship.code !== "campaign_total") {
      out.push(blocking({
        code: FINDING_CODES.BUDGET_BASIS_CONTRADICTS_RELATIONSHIP,
        group: "contradiction",
        channel,
        field: "budgetRelationship",
        title: "The budget basis and its arrangement disagree",
        explanation: `The plan's budget is a total, and the brief says it is ${relationship.label.toLowerCase()}.`,
        action: "Make the plan's budget basis and the brief's arrangement say the same thing.",
      }));
    }
    if (basis === "daily" && relationship.code === "campaign_total") {
      out.push(blocking({
        code: FINDING_CODES.BUDGET_BASIS_CONTRADICTS_RELATIONSHIP,
        group: "contradiction",
        channel,
        field: "budgetRelationship",
        title: "The budget basis and its arrangement disagree",
        explanation: "The plan's budget is a daily rate, and the brief says it is the campaign's entire spend.",
        action: "Make the plan's budget basis and the brief's arrangement say the same thing.",
      }));
    }
  }

  /* ── TRACKING AND TIMEZONE ────────────────────────────────────────────────── */
  if (needs.has("tracking") && !isSuppliedText(plan.utmCampaign)) {
    out.push(blocking({
      code: FINDING_CODES.TRACKING_IDENTITY_MISSING,
      group: "missing_from_plan",
      channel,
      field: "utmCampaign",
      title: "The campaign has no tracking identity",
      explanation: "Without one, this campaign's visits cannot be told apart from any other campaign's in analytics, and the figures can never be attributed.",
      action: "Set the campaign tracking identity on the plan.",
    }));
  }

  if (needs.has("schedule") && !isSuppliedText(brief.timezone)) {
    out.push(blocking({
      code: FINDING_CODES.SCHEDULE_TIMEZONE_MISSING,
      group: "missing_from_plan",
      channel,
      field: "timezone",
      title: "The schedule has no timezone",
      explanation: "The plan's dates are calendar days, and a day means different hours in each advertising account. Without a timezone the campaign starts and stops up to a day from what somebody intended.",
      action: "Set the timezone this campaign's schedule is in.",
    }));
  }

  return out;
}

/* ═══ PLAN-LEVEL EVALUATION ══════════════════════════════════════════════════ */

function evaluatePlan(plan) {
  const out = [];

  /* ── A ZERO BUDGET IS A REAL VALUE ────────────────────────────────────────
     `!plan.budget.amount` would treat zero as missing, which is the bug this note
     exists to prevent: a plan with no spend is a real plan, and telling somebody
     their budget is missing when they set it to nothing is both wrong and
     confusing. Absence is the sub-document being null. */
  const budget = plan.budget;
  /* ── AN ABSENT BUDGET IS A NULL SUB-DOCUMENT, NOT A FALSY AMOUNT ──────────
     `!budget` is the right test and `!budget.amount` would not be: zero is a real
     value. A budget object whose amount is not a number is neither absent nor
     valid, and is reported as missing rather than read as zero. */
  if (!budget || !isSuppliedNumber(budget.amount)) {
    out.push(blocking({
      code: FINDING_CODES.BUDGET_MISSING,
      group: "missing_from_plan",
      field: "budget",
      title: "The plan has no budget",
      explanation: "A campaign plan needs an amount before anybody can approve it. A budget of zero is a legitimate amount; no budget at all is not.",
      action: "Set the budget amount, its currency and whether it is a total or a daily figure.",
    }));
  } else {
    if (!isSuppliedText(budget.currency)) {
      out.push(blocking({
        code: FINDING_CODES.BUDGET_CURRENCY_MISSING,
        group: "missing_from_plan",
        field: "budget.currency",
        title: "The budget has no currency",
        explanation: "An amount without a currency is a number somebody will read in their own.",
        action: "Set the budget currency.",
      }));
    }
    if (!isSuppliedText(budget.basis)) {
      out.push(blocking({
        code: FINDING_CODES.BUDGET_BASIS_MISSING,
        group: "missing_from_plan",
        field: "budget.basis",
        title: "The budget does not say whether it is a total or a daily figure",
        explanation: "The same number means thirty times as much as a daily rate.",
        action: "Say whether the budget is a total or a daily figure.",
      }));
    }
  }

  /* ── SCHEDULE ─────────────────────────────────────────────────────────────── */
  /* Strict text: a schedule whose dates are numbers or booleans in a legacy
     snapshot is incomplete, not "2026". */
  const startDate = isSuppliedText(plan.schedule?.startDate) ? plan.schedule.startDate.trim() : "";
  const endDate = isSuppliedText(plan.schedule?.endDate) ? plan.schedule.endDate.trim() : "";
  if (!startDate || !endDate) {
    out.push(blocking({
      code: FINDING_CODES.SCHEDULE_INCOMPLETE,
      group: "missing_from_plan",
      field: "schedule",
      title: "The schedule is incomplete",
      explanation: "A campaign needs a start and an end before it can be approved or prepared.",
      action: "Set both the start and the end date.",
    }));
  } else if (startDate > endDate) {
    out.push(blocking({
      code: FINDING_CODES.SCHEDULE_REVERSED,
      group: "contradiction",
      field: "schedule",
      title: "The schedule runs backwards",
      explanation: "The start date is after the end date.",
      action: "Correct the dates.",
    }));
  }

  /* ── WHAT SUBMIT HAS ALWAYS REQUIRED ─────────────────────────────────────
     Submit refused a plan with no name or objective; readiness never looked, so
     it could call a plan "ready to submit" that Submit would then refuse. Judged
     here so both answer from one list. */
  if (!isSuppliedText(plan.name)) {
    out.push(blocking({
      code: FINDING_CODES.PLAN_NAME_MISSING,
      group: "missing_from_plan",
      field: "name",
      title: "The plan has no name",
      explanation: "An approver needs to know which plan they are deciding on.",
      action: "Give the plan a name.",
    }));
  }
  if (!isSuppliedText(plan.objective)) {
    out.push(blocking({
      code: FINDING_CODES.OBJECTIVE_MISSING,
      group: "missing_from_plan",
      field: "objective",
      title: "The plan has no objective",
      explanation: "A plan is approved for a purpose. Without one, nobody can say whether it worked.",
      action: "Choose the plan's objective.",
    }));
  }

  if (!list(plan.channels).length) {
    out.push(blocking({
      code: FINDING_CODES.BRIEF_MISSING,
      group: "missing_from_plan",
      field: "channels",
      title: "The plan names no channels",
      explanation: "A campaign with no channel is not a campaign.",
      action: "Choose at least one channel.",
    }));
  }

  return out;
}

/* ═══ THE VERDICT ════════════════════════════════════════════════════════════ */

/**
 * Evaluate a plan snapshot.
 *
 * @param {object} args
 * @param {object} args.plan a plan snapshot: the shape `present()` stores, or the
 *   document itself. NOT an id — this function reads nothing.
 * @returns {object} the readiness verdict
 */
function evaluate({ plan, now = new Date() } = {}) {
  if (!plan || typeof plan !== "object") {
    throw new Error("deploymentReadiness.evaluate needs a plan snapshot");
  }

  const briefByChannel = new Map(
    list(plan.deploymentBriefs).map((b) => [str(b.channel), b]),
  );

  const planFindings = evaluatePlan(plan);

  /* Channels in the plan's own order, so the result is stable for one snapshot. */
  const channels = list(plan.channels).map((code) => {
    const local = evaluateChannel({ plan, channel: code, brief: briefByChannel.get(code) || null });

    /* ── EVERY EXTERNAL CHECK, FOR EVERY ADVERTISING CHANNEL, ALWAYS ────────
       Appended here rather than inside the per-channel checks, because those
       return early on a missing brief or an unsupported type — and the external
       list vanishing in exactly those cases would suggest the checks had been
       answered. They have not been asked at all, whatever else is wrong.

       The media check is the one exception: it is raised by the creative check
       only when there is a reference to resolve. */
    const externals = CHANNEL_SUPPORT[code]
      ? EXTERNAL_CHECKS.map((check) => externalFinding(check, code))
      : [];

    const findings = [...local, ...externals];
    const blockingLocal = findings.filter(
      (f) => f.severity === "blocking" && f.group !== "external_check_required",
    );
    const outstanding = findings.filter((f) => f.group === "external_check_required");
    const spec = channelSpec(code);
    const publishes = Boolean(CHANNEL_SUPPORT[code]);

    return {
      channel: code,
      channelLabel: spec?.label || code,
      /* A channel that publishes nothing is not "ready" and not "blocked" — it is
         not part of advertising deployment at all. */
      publishesAdvertising: publishes,
      campaignType: publishes ? str(briefByChannel.get(code)?.campaignType) || null : null,
      campaignTypeLabel: publishes
        ? (typeSpec(str(briefByChannel.get(code)?.campaignType))?.label || null)
        : null,
      planReady: publishes ? blockingLocal.length === 0 : true,
      /* Always false: no external check has run. */
      deploymentReady: false,
      blockingCount: blockingLocal.length,
      externalChecksOutstanding: outstanding.length,
      findings,
    };
  });

  const advertisingChannels = channels.filter((c) => c.publishesAdvertising);

  /* ── EVERY PLAN NEEDS A CONVERSION GOAL ─────────────────────────────────
     Submit always required one. Readiness only asked through an advertising
     channel, so an email-only plan with no goal read "ready to submit" and was
     then refused. Raised at plan level only when no channel already raised it,
     so an advertising plan does not list the same gap twice. */
  const goalMissing = !isSuppliedText(plan.conversionGoal);
  const goalAlreadyReported = channels.some((c) => c.findings.some((f) => f.code === FINDING_CODES.CONVERSION_GOAL_MISSING));
  if (goalMissing && !goalAlreadyReported) {
    planFindings.push(blocking({
      code: FINDING_CODES.CONVERSION_GOAL_MISSING,
      group: "missing_from_plan",
      field: "conversionGoal",
      title: "The plan has no conversion goal",
      explanation: "A plan is judged by something agreed before it runs, not chosen afterwards from whatever looks best.",
      action: "Choose the conversion goal for this plan.",
    }));
  }

  /* ── IS ADVERTISING READINESS EVEN THE QUESTION? ──────────────────────────
     An email-only or measurement-only plan is a perfectly good plan with nothing to
     deploy to an advertising channel. Judging it against advertising requirements
     and reporting it as "missing advertising information" would be answering a
     question nobody asked, and a client would render blockers for fields that do
     not apply to it.

     So applicability is published, and every verdict below is defined for both
     cases rather than left for a client to infer. */
  const applicable = advertisingChannels.length > 0;

  const all = [...planFindings, ...channels.flatMap((c) => c.findings)];

  const localBlocking = all.filter(
    (f) => f.severity === "blocking" && f.group !== "external_check_required",
  );
  const externalOutstanding = all.filter((f) => f.group === "external_check_required");

  /* ── planReady ────────────────────────────────────────────────────────────
     The GRAV document holds what GRAV needs. It says nothing about the world.

     Not conditioned on having an advertising channel: an email-only plan whose own
     fields are complete IS plan-ready. Requiring one made a legitimate plan read as
     unready for a reason that did not apply to it. */
  const planReady = localBlocking.length === 0;

  /* ── approvalReady ────────────────────────────────────────────────────────
     Complete enough to put in front of an approver, and not already decided. A
     plan already approved is not "approval ready" — there is nothing to approve. */
  const state = str(plan.state);
  const approvalReady = planReady && ["draft", "returned"].includes(state);

  /* ── deploymentReady ──────────────────────────────────────────────────────
     ALWAYS FALSE in this chunk, and the reason is published rather than implied.
     Even a perfect approved plan is not deployable until the external conditions
     have been CHECKED, and nothing here checks any of them. */
  const approved = state === "approved";
  const deploymentReady = false;

  return {
    evaluatorVersion: EVALUATOR_VERSION,
    evaluatedAt: now.toISOString(),

    planReady,
    approvalReady,
    deploymentReady,

    /* Why not, in words, so no client has to infer it from three booleans. */
    /* ── APPLICABILITY, PUBLISHED RATHER THAN INFERRED ────────────────────────
       `false` for a plan with no advertising channel. A client must not render
       advertising blockers for one, and must not read `planReady` on such a plan as
       a statement about advertising. */
    applicable,

    deploymentBlockedBecause: (() => {
      /* A non-applicable plan is not blocked from deployment — there is nothing to
         deploy. Saying it is "missing advertising information" would be false. */
      if (!applicable) {
        return ["this plan has no advertising channel, so there is nothing to deploy to one"];
      }
      const reasons = [];
      if (!planReady) reasons.push("the plan is missing information GRAV needs");
      if (!approved) reasons.push("the plan has not been approved");
      reasons.push("the checks that only the advertising channel and the content library can answer have not been run");
      return reasons;
    })(),

    sections: {
      /* ── FOUR SECTIONS, FOUR DIFFERENT QUESTIONS ──────────────────────────
         Separated because they have different readers and different fixes. What a
         marketer can fix, what GRAV cannot do, what contradicts itself, and what
         nobody has asked yet. */
      locallyConfirmed: localConfirmations({ plan, channels: advertisingChannels, planFindings, all }),
      missingFromPlan: all.filter((f) => f.group === "missing_from_plan"),
      unsupportedByGrav: all.filter((f) => f.group === "unsupported_by_grav"),
      contradictions: all.filter((f) => f.group === "contradiction"),
      externalChecksRequired: externalOutstanding,
      /* Channels on the plan that carry no advertisements. Never a problem, and
         never counted as one. */
      notApplicable: all.filter((f) => f.group === "not_applicable"),
    },

    channels,

    counts: {
      blocking: localBlocking.length,
      advisory: all.filter((f) => f.severity === "advisory").length,
      externalOutstanding: externalOutstanding.length,
    },

    /* ── WHAT APPROVAL DID AND DID NOT DO ─────────────────────────────────────
       Carried in the payload, not left to a comment, because `approved` is the word
       a reader takes for "live". */
    approvalMeaning: {
      state,
      approved,
      createdAnything: false,
      committedMoney: false,
      activatedDelivery: false,
      providerAccepted: false,
      deliveryObjectsNonDeliveringConfirmed: false,
      means: "Approval is a GRAV decision about a GRAV plan. Nothing has been created in any advertising channel, no money can be spent because of it, nothing is delivering, no channel has accepted anything, and there is no external object whose delivery state has been read.",
    },
  };
}

/**
 * The local advertising blockers on a plan, for the submission and approval gates.
 *
 * ── EXTERNAL CHECKS DELIBERATELY EXCLUDED ──────────────────────────────────
 * They belong to deployment preflight, and nothing can answer them at submission
 * time. Blocking a submission on them would make an approvable plan unapprovable
 * for ever — the six outstanding checks never clear inside GRAV.
 *
 * Returns `null` when advertising readiness does not apply to this plan, so the
 * caller can tell "no advertising blockers" from "advertising is not the question".
 *
 * @returns {{applicable:boolean, blockers:object[], groups:object}|null}
 */
function localAdvertisingBlockers({ plan, now = new Date() }) {
  const verdict = evaluate({ plan, now });
  if (!verdict.applicable) return { applicable: false, blockers: [], groups: emptyGroups(), verdict };

  const blockers = [
    ...verdict.sections.missingFromPlan,
    ...verdict.sections.unsupportedByGrav,
    ...verdict.sections.contradictions,
  ].filter((f) => f.severity === "blocking");

  return {
    applicable: true,
    blockers,
    /* Grouped the same way the readiness response groups them, so a refusal and a
       readiness read describe one plan in one vocabulary. */
    groups: {
      missingFromPlan: verdict.sections.missingFromPlan.filter((f) => f.severity === "blocking"),
      unsupportedByGrav: verdict.sections.unsupportedByGrav.filter((f) => f.severity === "blocking"),
      contradictions: verdict.sections.contradictions.filter((f) => f.severity === "blocking"),
    },
    verdict,
  };
}

const emptyGroups = () => ({ missingFromPlan: [], unsupportedByGrav: [], contradictions: [] });

/* The field names Submit's refusal has always listed, in the order it listed
   them, derived from the findings rather than checked a second time. */
const MISSING_ORDER = ["name", "objective", "channels", "budget", "startDate", "endDate", "schedule", "conversionGoal"];
function missingFieldsOf(blockers, plan) {
  const out = new Set();
  for (const f of blockers.filter((b) => !b.channel)) {
    if (f.code === FINDING_CODES.SCHEDULE_INCOMPLETE) {
      if (!isSuppliedText(plan.schedule?.startDate)) out.add("startDate");
      if (!isSuppliedText(plan.schedule?.endDate)) out.add("endDate");
    } else if (String(f.field || "").startsWith("budget")) {
      out.add("budget");
    } else if (f.field) {
      out.add(f.field);
    }
  }
  return [...out].sort((a, b) => {
    const ia = MISSING_ORDER.indexOf(a);
    const ib = MISSING_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
}

/**
 * THE submission gate. The readiness route's `approvalReady`, Submit, and
 * Approve all answer from this one call, for one plan revision, so none of them
 * can say "ready" while another refuses.
 *
 * Local findings only — the external checks belong to deployment and nothing
 * inside GRAV can answer them.
 *
 * @returns {{ready:boolean, applicable:boolean, blockers:object[], groups:object, missing:string[], verdict:object}}
 */
function submissionGate({ plan, now = new Date() }) {
  const verdict = evaluate({ plan, now });
  const pick = (section) => verdict.sections[section].filter((f) => f.severity === "blocking");
  const groups = {
    missingFromPlan: pick("missingFromPlan"),
    unsupportedByGrav: pick("unsupportedByGrav"),
    contradictions: pick("contradictions"),
  };
  /* The evaluator's own `localBlocking` filter, applied to every finding, so
     `ready` here and `planReady` there are the same set by construction. */
  const blockers = [
    ...verdict.sections.missingFromPlan, ...verdict.sections.unsupportedByGrav,
    ...verdict.sections.contradictions, ...verdict.sections.notApplicable,
  ].filter((f) => f.severity === "blocking" && f.group !== "external_check_required");
  return {
    ready: blockers.length === 0,
    applicable: verdict.applicable,
    blockers,
    groups,
    missing: missingFieldsOf(blockers, plan),
    verdict,
  };
}

/**
 * What GRAV has actually confirmed, from the plan alone.
 *
 * Deliberately modest. Each entry is a fact about the DOCUMENT, and every one of
 * them is phrased so it cannot be read as a fact about the world.
 */
function localConfirmations({ plan, channels, planFindings, all }) {
  const confirmed = [];
  const hasFinding = (code) => all.some((f) => f.code === code);

  if (plan.budget && isSuppliedNumber(plan.budget.amount)
    && isSuppliedText(plan.budget.currency) && isSuppliedText(plan.budget.basis)) {
    confirmed.push({
      code: "BUDGET_RECORDED",
      title: "A budget is recorded with its currency and basis",
      detail: `${plan.budget.amount} ${plan.budget.currency}, ${plan.budget.basis === "daily" ? "per day" : "in total"}. GRAV has not compared this currency with any advertising account's.`,
    });
  }
  if (isSuppliedText(plan.schedule?.startDate) && isSuppliedText(plan.schedule?.endDate)
    && !hasFinding("SCHEDULE_REVERSED")) {
    confirmed.push({
      code: "SCHEDULE_RECORDED",
      title: "A start and end date are recorded, in order",
      detail: `${plan.schedule.startDate} to ${plan.schedule.endDate}.`,
    });
  }
  if (isSuppliedText(plan.utmCampaign)) {
    confirmed.push({
      code: "TRACKING_IDENTITY_RECORDED",
      title: "A campaign tracking identity is reserved",
      detail: "It is unique within this company and will not be reused.",
    });
  }
  for (const c of channels) {
    if (c.campaignType) {
      confirmed.push({
        code: "CAMPAIGN_TYPE_SUPPORTED",
        title: `${c.channelLabel}: ${c.campaignTypeLabel} is a type GRAV can prepare`,
        detail: "GRAV can describe every object this type needs. Whether the channel would accept them is not confirmed.",
      });
    }
  }
  if (list(plan.contentRefs).length) {
    confirmed.push({
      code: "CONTENT_REFERENCED",
      title: "Content is referenced by identifier",
      detail: `${plan.contentRefs.length} item${plan.contentRefs.length === 1 ? "" : "s"}. GRAV has not asked the content library whether they still exist.`,
    });
  }
  return confirmed;
}

/* Served with the result so a client never hard-codes a code, a label or a group. */
const vocabulary = Object.freeze({
  evaluatorVersion: EVALUATOR_VERSION,
  supportedCampaignTypes: SUPPORTED_CAMPAIGN_TYPES,
  channelSupport: CHANNEL_SUPPORT,
  biddingStrategies: BIDDING_STRATEGIES,
  budgetRelationships: BUDGET_RELATIONSHIPS,
  destinationKinds: DESTINATION_KINDS,
  exclusionDecisions: EXCLUSION_DECISIONS,
  findingGroups: FINDING_GROUPS,
  findingSeverities: FINDING_SEVERITIES,
  goalCompatibility: GOAL_COMPATIBILITY,
  channels: MARKETING_CHANNELS.map((c) => ({ code: c.code, label: c.label, role: c.role })),
  notClaimed: Object.freeze([
    "Readiness is a judgement about the GRAV document. It is not a statement about any advertising account.",
    "deploymentReady is always false in this release: the checks only the advertising channel and the content library can answer have not been run.",
    "Approval creates nothing, commits no money and confirms nothing about a provider.",
  ]),
});

module.exports = {
  evaluate, localAdvertisingBlockers, submissionGate, vocabulary, EVALUATOR_VERSION, EXTERNAL_CHECKS,
};
