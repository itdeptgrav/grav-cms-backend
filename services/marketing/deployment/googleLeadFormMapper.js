// services/marketing/deployment/googleLeadFormMapper.js
//
// AN APPROVED LEAD-FORM PLAN, AS THE GOOGLE OBJECTS THAT WOULD BE CREATED.
//
// ── A SEARCH CAMPAIGN WITH A FORM ATTACHED ─────────────────────────────────
// Google serves a lead form as an asset on a Search campaign. So this does not
// reinvent the campaign: it hands the plan to the Search mapper — the one place
// that decides what a plan's budget, bidding, schedule, advertisement, keywords
// and targeting become — and appends exactly two objects:
//
//   lead_form        an Asset carrying `lead_form_asset`
//   lead_form_link   a CampaignAsset, field type LEAD_FORM, status PAUSED
//
// The link is PAUSED as well as the campaign. Either on its own stops the form
// serving; both, so that starting the campaign alone in Google Ads still shows
// nobody a form until somebody also enables it deliberately.
//
// ── PURE, AND IT HOLDS NO SECRET ───────────────────────────────────────────
// No network, no clock, no environment. The webhook address and the derived
// `google_secret` are NOT part of the mapping: a mapping is fingerprinted,
// compared and handed to reconciliation, and a secret inside it would travel
// with all of that. The bundle injects delivery at the moment of sending.
"use strict";

const searchMapper = require("./googleSearchMapper");
const definition = require("./googleLeadFormDefinition");
const G = require("../../../constants/marketingGoogleLeadForm");
const { NON_DELIVERING_STATUS } = require("../../../constants/marketingGoogleSearchDeployment");

const str = (v) => String(v ?? "").trim();
const list = (v) => (Array.isArray(v) ? v : []);

const problem = (code, message, field) => ({ code, message, field });

/* The plan, with its Google brief presented to the Search mapper as the Search
   campaign it is. A copy — the stored plan is never altered. */
function asSearchPlan(plan) {
  const copy = JSON.parse(JSON.stringify(plan));
  copy._id = plan._id;
  copy.deploymentBriefs = list(copy.deploymentBriefs).map((b) => (
    b.channel === "google_ads" && b.campaignType === "google_lead_form"
      ? { ...b, campaignType: "google_search" }
      : b
  ));
  return copy;
}

/**
 * @param {object} args
 * @param {object} args.plan               the approved plan, as stored
 * @param {object} args.account            `{ currency, timeZone, externalAccountId }`
 * @param {object} args.resolvedTargeting  the preflight's resolution
 * @returns {{mappable:boolean, problems:object[], mapping:object|null, decisions:object[]}}
 */
function map({ plan, account = {}, resolvedTargeting = null }) {
  const brief = list(plan?.deploymentBriefs).find((b) => b.channel === "google_ads") || null;
  if (!brief || str(brief.campaignType) !== "google_lead_form") {
    return {
      mappable: false,
      problems: [problem("CAMPAIGN_TYPE_NOT_GOOGLE_LEAD_FORM", "This plan is not a Search campaign with a lead form.", "campaignType")],
      mapping: null,
      decisions: [],
    };
  }

  const search = searchMapper.map({ plan: asSearchPlan(plan), account, resolvedTargeting });
  const problems = [...(search.problems || [])];

  /* ── THE FORM, JUDGED BY THE SAME EVALUATOR AS READINESS ───────────────── */
  const form = brief.googleLeadForm || null;
  const verdict = definition.evaluate({ form, brief, plan, scope: "plan" });
  for (const c of verdict.blocking) {
    problems.push(problem("LEAD_FORM_INCOMPLETE", c.means, `googleLeadForm.${c.code}`));
  }

  if (problems.length || !search.mapping) {
    return { mappable: false, problems, mapping: null, decisions: search.decisions || [] };
  }

  /* The form opens from the advertisement and sends a click-through to the
     same page: the Search mapper's final URL, never a second address. */
  const ad = search.mapping.objects.find((o) => o.role === "advertisement");
  const finalUrl = str(list(ad?.payload?.ad?.finalUrls)[0]);
  const campaignName = search.mapping.campaignName;

  const fields = [
    ...list(form.fields).map(str).filter(Boolean),
    ...list(form.qualifyingQuestions).map(str).filter(Boolean),
  ].map((inputType) => ({ inputType }));

  const leadFormAsset = {
    businessName: str(form.businessName),
    headline: str(form.headline),
    description: str(form.description),
    callToActionType: str(form.callToAction),
    callToActionDescription: str(form.callToActionDescription),
    privacyPolicyUrl: str(form.privacyPolicyUrl),
    fields,
    ...(str(form.postSubmitHeadline) ? { postSubmitHeadline: str(form.postSubmitHeadline) } : {}),
    ...(str(form.postSubmitDescription) ? { postSubmitDescription: str(form.postSubmitDescription) } : {}),
    ...(str(form.postSubmitCallToAction) ? { postSubmitCallToActionType: str(form.postSubmitCallToAction) } : {}),
  };

  const objects = [
    ...search.mapping.objects,
    {
      role: "lead_form",
      payload: {
        /* Named for the campaign, so a form in the account can be traced back. */
        name: `${campaignName} lead form`,
        finalUrls: [finalUrl],
        leadFormAsset,
      },
    },
    {
      role: "lead_form_link",
      payload: { fieldType: "LEAD_FORM", status: NON_DELIVERING_STATUS },
    },
  ];

  return {
    mappable: true,
    problems: [],
    decisions: [
      ...(search.decisions || []),
      {
        code: "LEAD_FORM_LINK_STOPPED",
        decision: `The form is attached to the campaign with status ${NON_DELIVERING_STATUS}, as well as the campaign itself.`,
        why: "Starting the campaign alone in Google Ads must not show anybody the form. Enabling the form is a second, deliberate act.",
      },
      {
        code: "LEAD_FORM_DELIVERY_SCHEMA",
        decision: `Google is asked to deliver in payload schema version ${G.DELIVERY.PAYLOAD_SCHEMA_VERSION}.`,
        why: "Google's own lead-form sample sets this version; its webhook documentation says the version can be ignored for now.",
      },
    ],
    mapping: {
      ...search.mapping,
      campaignType: "google_lead_form",
      objects,
      summary: {
        ...(search.mapping.summary || {}),
        leadForm: {
          businessName: leadFormAsset.businessName,
          headline: leadFormAsset.headline,
          callToAction: leadFormAsset.callToActionType,
          asks: fields.map((f) => f.inputType),
          privacyPolicyUrl: leadFormAsset.privacyPolicyUrl,
          createdStatus: NON_DELIVERING_STATUS,
        },
      },
    },
  };
}

module.exports = { map, asSearchPlan };
