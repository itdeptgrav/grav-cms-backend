#!/usr/bin/env node
"use strict";

/*
 * Local development Marketing story.
 *
 * This script never calls an advertising channel, the email engine, Gemini, or
 * Sales. It writes only GRAV-owned development records into a database whose
 * name is literally `test`. Records are tagged with the `demo_marketing_`
 * campaign identity prefix and can be removed with `--purge`.
 *
 * Usage:
 *   node -r dotenv/config scripts/marketing/seed-demo.js --apply
 *   node -r dotenv/config scripts/marketing/seed-demo.js --purge
 */

const crypto = require("crypto");
const mongoose = require("mongoose");

const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const {
  MarketingCampaignDraft,
  MarketingCampaignDraftHistory,
} = require("../../models/CMS_Models/Marketing/MarketingCampaignDraft");
const {
  MarketingCampaignDeployment,
} = require("../../models/CMS_Models/Marketing/MarketingCampaignDeployment");
const {
  MarketingCampaignObservation,
  MarketingCampaignObservationRevision,
} = require("../../models/CMS_Models/Marketing/MarketingCampaignObservation");
const {
  MarketingCampaignAnalysis,
  MarketingCampaignAnalysisDismissal,
} = require("../../models/CMS_Models/Marketing/MarketingCampaignAnalysis");
const drafts = require("../../services/marketing/campaignDrafts/campaignDraft.service");
const tracking = require("../../services/marketing/trackingConfig.service");

const DEMO_PREFIX = "demo_marketing_";
const EXPECTED_DB = "test";

const day = (offset) => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};

const fingerprint = (facts) => crypto
  .createHash("sha256")
  .update(JSON.stringify(facts))
  .digest("hex");

const userFrom = (row, fallbackName, role) => ({
  id: String(row?._id || new mongoose.Types.ObjectId()),
  name: String(row?.name || row?.fullName || fallbackName),
  email: String(row?.email || ""),
  role,
  isAdmin: role === "admin" || role === "ceo",
});

async function actors(db) {
  const marketerRow = await db.collection("users").findOne({});
  const approverRow = await db.collection("dept_users").findOne({ isAdmin: true });
  return {
    marketer: userFrom(marketerRow, "Marketing Demo", "marketing"),
    approver: userFrom(approverRow, "Demo Approver", "admin"),
  };
}

const googleBrief = {
  channel: "google_ads",
  campaignType: "google_search",
  destination: { kind: "grav_site_url", url: "https://gravclothing.com/uniforms" },
  geoTargeting: [
    { name: "India", kind: "country" },
    { name: "Maharashtra", kind: "region" },
  ],
  geoExclusions: [{ name: "Jammu and Kashmir", kind: "region" }],
  languages: ["en", "hi"],
  audiences: [{ name: "Uniform procurement teams", kind: "search_intent" }],
  exclusionDecision: "none_required",
  exclusions: [],
  bidding: { strategy: "maximise_clicks" },
  budgetRelationship: "campaign_total",
  googleSearch: {
    headlines: ["Corporate uniforms", "Bulk uniform orders", "Made for Indian teams"],
    descriptions: [
      "Uniform programmes for hospitality, healthcare and industry.",
      "Plan sizing, branding and delivery with one manufacturing partner.",
    ],
    keywordThemes: ["corporate uniforms", "hotel uniforms", "factory uniforms"],
  },
  timezone: "Asia/Kolkata",
};

async function createPlan({ companyId, user, payload }) {
  return drafts.create({ companyId, user, payload });
}

async function ensurePlans(companyId, marketer, approver) {
  const approved = await createPlan({
    companyId,
    user: marketer,
    payload: {
      name: "Corporate uniform enquiries — West India",
      objective: "lead_generation",
      description: "Generate qualified bulk-uniform enquiries from procurement teams.",
      channels: ["google_ads"],
      startDate: "2026-09-01",
      endDate: "2026-12-15",
      budgetAmount: 150000,
      budgetCurrency: "INR",
      budgetBasis: "total",
      conversionGoal: "form_submission",
      utmCampaign: `${DEMO_PREFIX}west_india_search`,
      deploymentBriefs: [googleBrief],
      idempotencyKey: `${DEMO_PREFIX}create_google_v1`,
    },
  });
  let approvedStored = await MarketingCampaignDraft.findOne({ companyId, utmCampaign: `${DEMO_PREFIX}west_india_search` }).lean();
  if (approvedStored?.state === "draft") {
    /* The revision the stored plan actually has now, which a re-run of the
       seed may have moved past 1. */
    await drafts.submit({
      companyId, user: marketer, campaignDraftId: approved.campaignDraftId,
      expectedRevision: approvedStored.revision,
    });
    approvedStored = await MarketingCampaignDraft.findById(approvedStored._id).lean();
  }
  if (approvedStored?.state === "awaiting_approval") {
    await drafts.decide({
      companyId,
      user: approver,
      campaignDraftId: approved.campaignDraftId,
      decision: "approve",
      reason: "Approved for the development demonstration.",
    });
  }

  await createPlan({
    companyId,
    user: marketer,
    payload: {
      name: "Hospitality winter collection",
      objective: "traffic",
      description: "A draft Meta campaign waiting for its image and audience decisions.",
      channels: ["meta_ads"],
      startDate: "2026-10-01",
      endDate: "2026-11-30",
      budgetAmount: 5000,
      budgetCurrency: "INR",
      budgetBasis: "daily",
      conversionGoal: "page_view",
      utmCampaign: `${DEMO_PREFIX}hospitality_meta`,
      idempotencyKey: `${DEMO_PREFIX}create_meta_v1`,
    },
  });

  const awaiting = await createPlan({
    companyId,
    user: marketer,
    payload: {
      name: "Existing-customer uniform care guide",
      objective: "retention",
      description: "A consented email plan submitted for a decision.",
      channels: ["email"],
      startDate: "2026-10-05",
      endDate: "2026-10-31",
      budgetAmount: 0,
      budgetCurrency: "INR",
      budgetBasis: "total",
      conversionGoal: "page_view",
      utmCampaign: `${DEMO_PREFIX}care_guide_email`,
      idempotencyKey: `${DEMO_PREFIX}create_email_v1`,
    },
  });
  const awaitingStored = await MarketingCampaignDraft.findOne({ companyId, utmCampaign: `${DEMO_PREFIX}care_guide_email` }).lean();
  if (awaitingStored?.state === "draft") {
    /* The revision the stored plan actually has now, which a re-run of the
       seed may have moved past 1. */
    await drafts.submit({
      companyId, user: marketer, campaignDraftId: awaiting.campaignDraftId,
      expectedRevision: awaitingStored.revision,
    });
  }

  const rejected = await createPlan({
    companyId,
    user: marketer,
    payload: {
      name: "Unfocused nationwide awareness test",
      objective: "awareness",
      description: "Kept to demonstrate a declined plan and its reason.",
      channels: ["email"],
      startDate: "2026-10-01",
      endDate: "2026-10-20",
      budgetAmount: 25000,
      budgetCurrency: "INR",
      budgetBasis: "total",
      conversionGoal: "page_view",
      utmCampaign: `${DEMO_PREFIX}rejected_awareness`,
      idempotencyKey: `${DEMO_PREFIX}create_rejected_v1`,
    },
  });
  let rejectedStored = await MarketingCampaignDraft.findOne({ companyId, utmCampaign: `${DEMO_PREFIX}rejected_awareness` }).lean();
  if (rejectedStored?.state === "draft") {
    /* The revision the stored plan actually has now, which a re-run of the
       seed may have moved past 1. */
    await drafts.submit({
      companyId, user: marketer, campaignDraftId: rejected.campaignDraftId,
      expectedRevision: rejectedStored.revision,
    });
    rejectedStored = await MarketingCampaignDraft.findById(rejectedStored._id).lean();
  }
  if (rejectedStored?.state === "awaiting_approval") {
    await drafts.decide({
      companyId,
      user: approver,
      campaignDraftId: rejected.campaignDraftId,
      decision: "reject",
      reason: "The audience and success measure are too broad to approve.",
    });
  }

  return drafts.loadForDeployment({ companyId, campaignDraftId: approved.campaignDraftId });
}

async function ensurePerformance(companyId, approvedPlan, approver) {
  const deployment = await MarketingCampaignDeployment.findOneAndUpdate(
    {
      companyId,
      campaignDraftId: approvedPlan._id,
      approvedRevision: approvedPlan.revision,
      channel: "google_ads",
    },
    {
      $setOnInsert: {
        companyId,
        campaignDraftId: approvedPlan._id,
        draftRef: approvedPlan.draftRef,
        approvedRevision: approvedPlan.revision,
        channel: "google_ads",
        campaignType: "google_search",
        idempotencyKey: `${DEMO_PREFIX}deployment_google_v1`,
        deploymentMarker: `${DEMO_PREFIX}marker_google_v1`,
        state: "paused_confirmed",
        externalObjects: [{
          role: "campaign",
          providerObjectId: "demo-google-campaign-1001",
          deliveryStateApplies: true,
          nonDeliveringConfirmed: true,
          stateReadAt: new Date(),
          observedState: "PAUSED",
          createdAt: new Date(),
        }],
        deploymentApprovedBy: {
          id: new mongoose.Types.ObjectId(approver.id),
          name: approver.name,
          role: approver.role,
          at: new Date(),
        },
        deliveryObjectsNonDeliveringConfirmedAt: new Date(),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  const rows = [];
  for (let i = -17; i <= -4; i += 1) {
    const recent = i >= -10;
    const ordinal = i + 18;
    const impressions = recent ? 1450 + ordinal * 35 : 950 + ordinal * 25;
    const clicks = recent ? 76 + ordinal * 2 : 36 + ordinal;
    const conversions = recent ? 5 + (ordinal % 2) : 2 + (ordinal % 2);
    const spendMicros = recent ? 175000000 + ordinal * 2500000 : 120000000 + ordinal * 1800000;
    const facts = {
      impressions,
      reach: null,
      clicks,
      landingPageViews: null,
      spendMinorUnits: Math.round(spendMicros / 10000),
      spendMicros,
      conversions,
      conversionValueMinorUnits: null,
      conversionValueMicros: null,
      completeness: "complete",
    };
    rows.push({
      updateOne: {
        filter: { companyId, deploymentId: deployment._id, reportingDate: day(i) },
        update: {
          $set: {
            companyId,
            campaignDraftId: approvedPlan._id,
            draftRef: approvedPlan.draftRef,
            approvedRevision: approvedPlan.revision,
            deploymentId: deployment._id,
            channel: "google_ads",
            externalAccountId: "demo-google-account",
            externalCampaignId: "demo-google-campaign-1001",
            reportingDate: day(i),
            reportingTimeZone: "Asia/Kolkata",
            currency: "INR",
            ...facts,
            conversionBasis: {
              countedTypes: ["form_submission"],
              means: "Form submissions configured for this development campaign.",
            },
            incompleteReason: "",
            observedAt: new Date(),
            metricRevision: 1,
            factsFingerprint: fingerprint(facts),
          },
        },
        upsert: true,
      },
    });
  }
  await MarketingCampaignObservation.bulkWrite(rows, { ordered: true });

  return { deployment, observationCount: rows.length };
}

const audienceMix = Object.freeze([
  ["SYNCHRONIZED", 14],
  ["MISSING_MAPPING", 5],
  ["CONSENT_INELIGIBLE", 6],
  ["SUPPRESSED", 3],
  ["RETRY_DUE", 2],
  ["RETRY_WAITING", 1],
  ["BLOCKED_TERMINAL", 1],
]);

async function ensureAudienceStory(companyId) {
  const db = mongoose.connection.db;
  const now = new Date();
  const identities = [];
  const consents = [];
  const deliveries = [];
  const events = [];
  const receipts = [];
  let index = 0;

  for (const [category, count] of audienceMix) {
    for (let n = 0; n < count; n += 1) {
      index += 1;
      const key = `${DEMO_PREFIX}person_${String(index).padStart(2, "0")}`;
      const identityId = new mongoose.Types.ObjectId();
      const email = `buyer${String(index).padStart(2, "0")}@example${(index % 6) + 1}.com`;
      const externalId = `demo-contact-${1000 + index}`;
      identities.push({
        updateOne: {
          filter: { companyId, gravPersonKey: key },
          update: { $set: {
            companyId, gravPersonKey: key, email,
            companyDomain: email.split("@")[1],
            normalizedPhone: `+91990000${String(index).padStart(4, "0")}`,
            externals: category === "SYNCHRONIZED" ? [{
              system: "mautic", externalId, proven: true,
              linkedAt: new Date(now.getTime() - 20 * 86_400_000),
              lastSyncedAt: new Date(now.getTime() - (index % 8) * 3_600_000),
              lastSyncError: "",
            }] : [],
            updatedAt: now,
          }, $setOnInsert: { _id: identityId, createdAt: new Date(now.getTime() - 30 * 86_400_000) } },
          upsert: true,
        },
      });

      const isIneligible = category === "CONSENT_INELIGIBLE";
      const state = category === "SUPPRESSED" ? "suppressed"
        : (isIneligible ? (n % 2 ? "opted_out" : "unknown") : "opted_in");
      consents.push({
        updateOne: {
          filter: { companyId, gravPersonKey: key, channel: "email", purpose: "marketing" },
          update: { $set: {
            companyId, gravPersonKey: key, channel: "email", purpose: "marketing", state,
            capturedSource: "Demo website enquiry form", capturedAt: new Date(now.getTime() - 30 * 86_400_000),
            noticeVersion: "demo-2026-01", evidenceRef: `${DEMO_PREFIX}consent_${index}`,
            recordedBy: { name: "Marketing demo", kind: "system" }, recordedAt: now,
            withdrawnAt: ["opted_out", "suppressed"].includes(state) ? new Date(now.getTime() - 5 * 86_400_000) : null,
            withdrawalReason: state === "suppressed" ? "Demonstration suppression" : (state === "opted_out" ? "Demonstration opt-out" : ""),
            lastCommandKey: `${DEMO_PREFIX}consent_${index}`, revision: 1, updatedAt: now,
          }, $setOnInsert: { createdAt: now } },
          upsert: true,
        },
      });

      if (!["CONSENT_INELIGIBLE", "SUPPRESSED", "MISSING_MAPPING"].includes(category)) {
        const common = {
          companyId, gravPersonKey: key, attempts: 1, retryCount: 0,
          lastAttemptAt: new Date(now.getTime() - 3 * 3_600_000),
          lastSuccessfulSyncAt: null, inFlightSince: null, nextAttemptAt: null,
          lastOutcome: "FAILURE", mauticContactId: "", consentReasonCode: "",
          claim: {}, updatedAt: now,
        };
        let specific;
        if (category === "SYNCHRONIZED") specific = {
          health: "SYNCHRONIZED", lastOutcome: "SUCCESS", mauticContactId: externalId,
          lastSuccessfulSyncAt: new Date(now.getTime() - (index % 8) * 3_600_000), activeError: null,
        };
        if (category === "RETRY_DUE" || category === "RETRY_WAITING") specific = {
          health: "RETRY_SCHEDULED", retryCount: 1,
          nextAttemptAt: new Date(now.getTime() + (category === "RETRY_DUE" ? -2 : 4) * 3_600_000),
          activeError: {
            reasonCode: "MAUTIC_UNREACHABLE", sourceCode: "DEMO_TIMEOUT", failureClass: "TRANSIENT",
            message: "The previous demonstration sync could not reach the marketing engine.", at: now, attemptNo: 1,
          },
        };
        if (category === "BLOCKED_TERMINAL") specific = {
          health: "BLOCKED_TERMINAL",
          activeError: {
            reasonCode: "PROJECTION_INVALID", sourceCode: "DEMO_REVIEW", failureClass: "TERMINAL",
            message: "This demonstration person needs an administrator to review the mapping.", at: now, attemptNo: 1,
          },
        };
        deliveries.push({
          updateOne: {
            filter: { companyId, gravPersonKey: key },
            update: { $set: { ...common, ...specific }, $setOnInsert: { createdAt: now } },
            upsert: true,
          },
        });
      }

      if (index <= 18) {
        const eventId = new mongoose.Types.ObjectId();
        const sourceEventId = `${DEMO_PREFIX}engagement_${index}`;
        const kind = index % 4 === 0 ? "form_submitted" : (index % 3 === 0 ? "email_clicked" : "page_viewed");
        const occurredAt = new Date(now.getTime() - index * 4 * 3_600_000);
        events.push({ updateOne: {
          filter: { companyId, source: "mautic", sourceEventId },
          update: { $setOnInsert: {
            _id: eventId, companyId, source: "mautic", sourceEventId, kind,
            externalContactId: externalId, email, gravPersonKey: key,
            campaignId: "demo-content-campaign", campaignName: "Uniform buying guide",
            assetName: kind === "form_submitted" ? "Bulk enquiry form" : "2026 uniform guide",
            topics: ["corporate uniforms", "bulk ordering"], occurredAt, receivedAt: occurredAt,
            evidence: { providerRecordType: "demo", providerRecordId: String(index), providerEventType: kind },
            createdAt: occurredAt, updatedAt: occurredAt,
          } }, upsert: true,
        } });
        receipts.push({ updateOne: {
          filter: { companyId, source: "mautic", sourceEventId },
          update: { $setOnInsert: {
            companyId, source: "mautic", sourceEventId, eventId, kind, occurredAt,
            state: kind === "form_submitted" ? "ACTIVITY_PROJECTED" : "IGNORED",
            ignoredReason: kind === "form_submitted" ? "" : "TELEMETRY_ONLY",
            gravPersonKey: key, resolvedBy: "canonical_identity", resolvedAt: occurredAt,
            suppression: {}, activity: kind === "form_submitted" ? { state: "PROJECTED", at: occurredAt, attempts: 1 } : {},
            createdAt: occurredAt, updatedAt: occurredAt,
          } }, upsert: true,
        } });
      }
    }
  }

  await db.collection("marketing_identities").bulkWrite(identities, { ordered: true });
  await db.collection("marketing_consents").bulkWrite(consents, { ordered: true });
  if (deliveries.length) await db.collection("marketing_delivery_state").bulkWrite(deliveries, { ordered: true });
  await db.collection("marketing_intent_events").bulkWrite(events, { ordered: true });
  await db.collection("marketing_event_receipts").bulkWrite(receipts, { ordered: true });
  return { people: index, events: events.length };
}

const handoverStories = Object.freeze([
  { suffix: "001", state: "AWAITING_REVIEW", first: "Aarav", last: "Shah", job: "Procurement Manager", organisation: "Northstar Hotels", domain: "northstar.example", fit: "strong", intent: "explicit_request", action: "call_within_one_business_day" },
  { suffix: "002", state: "ACCEPTED", first: "Meera", last: "Nair", job: "Operations Director", organisation: "Prism Healthcare", domain: "prism.example", fit: "strong", intent: "high", action: "call_within_one_business_day" },
  { suffix: "003", state: "RETURNED", first: "Kabir", last: "Malhotra", job: "Administration Lead", organisation: "Cedar Schools", domain: "cedar.example", fit: "possible", intent: "moderate", action: "email_introduction" },
  { suffix: "004", state: "REJECTED", first: "Tara", last: "Iyer", job: "Office Manager", organisation: "Bluewave Studio", domain: "bluewave.example", fit: "weak", intent: "low", action: "research_before_contact" },
  { suffix: "005", state: "BLOCKED", first: "Dev", last: "Kapoor", job: "Facilities Lead", organisation: "Summit Works", domain: "summit.example", fit: "possible", intent: "moderate", action: "research_before_contact" },
]);

async function ensureHandovers(companyId, marketer, approver) {
  const db = mongoose.connection.db;
  const now = new Date();
  for (let i = 0; i < handoverStories.length; i += 1) {
    const story = handoverStories[i];
    const handoverRef = `MKT-DEMO-${story.suffix}`;
    const correlationId = `${DEMO_PREFIX}handover_${story.suffix}`;
    const handoverId = new mongoose.Types.ObjectId();
    const submittedAt = story.state === "BLOCKED" ? null : new Date(now.getTime() - (i + 2) * 24 * 3_600_000);
    const decidedAt = ["ACCEPTED", "RETURNED", "REJECTED"].includes(story.state)
      ? new Date(submittedAt.getTime() + (i + 3) * 3_600_000) : null;
    const outcome = decidedAt ? {
      decision: story.state, decidedAt,
      decidedBy: { id: new mongoose.Types.ObjectId(approver.id), name: approver.name, email: approver.email },
      reason: story.state === "RETURNED" ? "Continue nurturing around the next uniform refresh."
        : (story.state === "REJECTED" ? "The organisation is outside the current account profile." : ""),
      nurtureTopic: story.state === "RETURNED" ? "New academic-year uniforms" : "",
      revisitAt: story.state === "RETURNED" ? new Date(now.getTime() + 30 * 86_400_000) : null,
      salesRecordType: story.state === "ACCEPTED" ? "Prospect" : "",
      salesRecordRef: story.state === "ACCEPTED" ? "PROS-DEMO-002" : "",
    } : undefined;
    await db.collection("marketing_prospect_handovers").updateOne(
      { companyId, handoverRef },
      { $set: {
        companyId, handoverRef, state: story.state,
        company: { name: story.organisation, website: `https://${story.domain}`, domain: story.domain, country: "India", sizeBand: "201–500", industry: "Services" },
        person: { firstName: story.first, lastName: story.last, jobTitle: story.job, workEmail: `${story.first.toLowerCase()}@${story.domain}`, workPhone: "+91 90000 00000" },
        marketing: { sourceSystem: "mautic", source: "Website enquiry", campaignId: "demo-campaign", campaignName: "Corporate uniform enquiries — West India", assetName: "Bulk uniform enquiry", firstSeenAt: new Date(now.getTime() - 40 * 86_400_000), lastEngagedAt: new Date(now.getTime() - (i + 1) * 86_400_000) },
        permission: { emailConsent: story.state === "BLOCKED" ? "opted_out" : "opted_in", phoneConsent: "unknown", capturedAt: new Date(now.getTime() - 40 * 86_400_000), capturedSource: "Demo website form", noticeVersion: "demo-2026-01", suppressed: story.state === "BLOCKED", suppressionReason: story.state === "BLOCKED" ? "Consent withdrawn before handover" : "", acquisitionPausedAt: story.state === "ACCEPTED" ? decidedAt : null },
        activities: [
          { kind: "page_viewed", occurredAt: new Date(now.getTime() - 5 * 86_400_000), campaignName: "Corporate uniform enquiries — West India", assetName: "Uniform programme guide", detail: "Viewed the procurement guide.", sourceEventId: `${DEMO_PREFIX}handover_event_${story.suffix}_1` },
          { kind: "form_submitted", occurredAt: new Date(now.getTime() - 3 * 86_400_000), campaignName: "Corporate uniform enquiries — West India", assetName: "Bulk uniform enquiry", detail: "Requested information about a company uniform programme.", sourceEventId: `${DEMO_PREFIX}handover_event_${story.suffix}_2` },
        ],
        topicsOfInterest: ["corporate uniforms", "branding", "bulk ordering"],
        assessment: { accountFit: story.fit, accountFitFactors: ["Indian organisation", "Multi-team requirement"], intent: story.intent, intentFactors: ["Recent enquiry", "Repeated content engagement"], handoverReason: `${story.organisation} showed a recent, specific interest in a uniform programme.`, recommendedAction: story.action, evidenceFreshnessHours: (i + 1) * 12, rulesVersion: "demo-2026-01" },
        matchKeys: { normalizedEmail: `${story.first.toLowerCase()}@${story.domain}`, companyDomain: story.domain, normalizedCompanyName: story.organisation.toLowerCase() },
        sourceEventIds: [`${DEMO_PREFIX}handover_event_${story.suffix}_1`, `${DEMO_PREFIX}handover_event_${story.suffix}_2`],
        submittedAt, submittedBy: { id: new mongoose.Types.ObjectId(marketer.id), name: marketer.name, email: marketer.email },
        ...(outcome ? { outcome } : {}),
        blockedReason: story.state === "BLOCKED" ? "Marketing permission was withdrawn before submission." : "",
        correlationId, updatedAt: now,
      }, $setOnInsert: { _id: handoverId, createdAt: submittedAt || now } },
      { upsert: true },
    );
    const stored = await db.collection("marketing_prospect_handovers").findOne({ companyId, handoverRef });
    if (story.state !== "BLOCKED") {
      await db.collection("marketing_outbox_events").updateOne(
        { companyId, correlationId, kind: "marketing.prospect_handover.submitted" },
        { $set: {
          companyId, kind: "marketing.prospect_handover.submitted", payload: { handoverId: stored._id, handoverRef },
          occurredAt: submittedAt, actor: { id: new mongoose.Types.ObjectId(marketer.id), name: marketer.name, email: marketer.email }, correlationId,
          status: "DELIVERED", attempts: 1, lastAttemptAt: new Date(submittedAt.getTime() + 15 * 60_000), lastError: "", deliveredAt: new Date(submittedAt.getTime() + 15 * 60_000), updatedAt: now,
        }, $setOnInsert: { createdAt: submittedAt } },
        { upsert: true },
      );
    }
    await db.collection("marketing_audit_events").updateOne(
      { companyId, dedupeKey: `${DEMO_PREFIX}audit_${story.suffix}` },
      { $setOnInsert: {
        companyId, handoverRef, handoverId: stored._id, action: story.state === "BLOCKED" ? "BLOCKED" : "SUBMITTED",
        actor: { id: new mongoose.Types.ObjectId(marketer.id), name: marketer.name, email: marketer.email }, at: submittedAt || now,
        reason: story.state === "BLOCKED" ? "Consent did not allow submission." : "Qualified engagement submitted for Sales review.",
        previousState: "", resultingState: story.state, correlationId, dedupeKey: `${DEMO_PREFIX}audit_${story.suffix}`,
        createdAt: submittedAt || now, updatedAt: submittedAt || now,
      } }, { upsert: true },
    );
  }
  return { handovers: handoverStories.length };
}

async function ensureTracking(companyId, approver) {
  const existing = await mongoose.connection.db.collection("marketing_tracking_configs").findOne({ companyId });
  if (existing && existing.siteUrl !== "https://gravclothing.com") return { preservedExisting: true };
  const result = await tracking.save({
    companyId,
    actor: approver,
    payload: {
      siteUrl: "https://gravclothing.com",
      trackingMode: "gtm",
      gtmContainerId: "GTM-DEMO26",
      ga4MeasurementId: "G-DEMO2026",
      metaPixelId: "202609200001",
      enabled: false,
      expectedRevision: Number(existing?.revision) || 0,
      note: "Demonstration identifiers only. Tracking remains disabled and unverified.",
    },
  });
  return { revision: result.revision, enabled: false };
}

async function purge(companyId) {
  const db = mongoose.connection.db;
  const plans = await MarketingCampaignDraft.find({
    companyId,
    utmCampaign: { $regex: `^${DEMO_PREFIX}` },
  }).select("_id").lean();
  const intents = await db.collection("marketing_campaign_create_intents").find({
    companyId,
    idempotencyKey: { $regex: `^${DEMO_PREFIX}` },
  }).project({ draftId: 1 }).toArray();
  const ids = [...new Map(
    [...plans, ...intents]
      .filter((row) => row._id || row.draftId)
      .map((row) => {
        const id = row.draftId || row._id;
        return [String(id), id];
      }),
  ).values()];
  if (!ids.length) return { plans: 0, deployments: 0 };

  const deployments = await MarketingCampaignDeployment.find({
    companyId,
    campaignDraftId: { $in: ids },
  }).select("_id").lean();
  const deploymentIds = deployments.map((d) => d._id);

  /* These records are append-only in application code. Purging is an explicit
     development-only reset, so it uses the collections directly rather than
     weakening those model guards. The database-name and tag checks above keep
     the reset tightly scoped. */
  await db.collection("marketing_campaign_analysis_dismissals").deleteMany({ companyId, campaignDraftId: { $in: ids } });
  await db.collection("marketing_campaign_analyses").deleteMany({ companyId, campaignDraftId: { $in: ids } });
  await db.collection("marketing_campaign_observation_revisions").deleteMany({ companyId, deploymentId: { $in: deploymentIds } });
  await db.collection("marketing_campaign_observations").deleteMany({ companyId, deploymentId: { $in: deploymentIds } });
  await db.collection("marketing_campaign_deployments").deleteMany({ companyId, campaignDraftId: { $in: ids } });
  await db.collection("marketing_campaign_draft_history").deleteMany({ companyId, draftId: { $in: ids } });
  await db.collection("marketing_campaign_identities").deleteMany({ companyId, draftId: { $in: ids } });
  await db.collection("marketing_campaign_create_intents").deleteMany({
    companyId,
    $or: [
      { draftId: { $in: ids } },
      { idempotencyKey: { $regex: `^${DEMO_PREFIX}` } },
    ],
  });
  await db.collection("marketing_campaign_drafts").deleteMany({ companyId, _id: { $in: ids } });
  await db.collection("marketing_event_receipts").deleteMany({ companyId, sourceEventId: { $regex: `^${DEMO_PREFIX}` } });
  await db.collection("marketing_intent_events").deleteMany({ companyId, sourceEventId: { $regex: `^${DEMO_PREFIX}` } });
  await db.collection("marketing_consent_history").deleteMany({ companyId, gravPersonKey: { $regex: `^${DEMO_PREFIX}` } });
  await db.collection("marketing_consents").deleteMany({ companyId, gravPersonKey: { $regex: `^${DEMO_PREFIX}` } });
  await db.collection("marketing_delivery_state").deleteMany({ companyId, gravPersonKey: { $regex: `^${DEMO_PREFIX}` } });
  await db.collection("marketing_identities").deleteMany({ companyId, gravPersonKey: { $regex: `^${DEMO_PREFIX}` } });
  await db.collection("marketing_acquisition_holds").deleteMany({ companyId, handoverRef: { $regex: "^MKT-DEMO-" } });
  await db.collection("marketing_audit_events").deleteMany({ companyId, dedupeKey: { $regex: `^${DEMO_PREFIX}` } });
  await db.collection("marketing_outbox_events").deleteMany({ companyId, correlationId: { $regex: `^${DEMO_PREFIX}` } });
  await db.collection("marketing_prospect_handovers").deleteMany({ companyId, handoverRef: { $regex: "^MKT-DEMO-" } });
  const demoTracking = await db.collection("marketing_tracking_configs").findOne({ companyId, siteUrl: "https://gravclothing.com" });
  if (demoTracking) {
    await db.collection("marketing_tracking_config_history").deleteMany({ companyId });
    await db.collection("marketing_tracking_configs").deleteOne({ companyId, _id: demoTracking._id });
  }
  return { plans: ids.length, deployments: deploymentIds.length };
}

async function main() {
  const apply = process.argv.includes("--apply");
  const remove = process.argv.includes("--purge");
  if (apply === remove) throw new Error("Choose exactly one of --apply or --purge.");

  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is not configured.");
  if (!process.env.MARKETING_CHANNEL_ID_SECRET) {
    throw new Error("MARKETING_CHANNEL_ID_SECRET is required to issue readable demo plan identifiers.");
  }

  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  if (mongoose.connection.name !== EXPECTED_DB) {
    throw new Error(`Refusing to seed database ${mongoose.connection.name}; this script only writes to ${EXPECTED_DB}.`);
  }

  const companies = await Acc_Company.find({}).select("_id companyName").limit(2).lean();
  if (companies.length !== 1) {
    throw new Error(`Refusing to seed: expected exactly one company, found ${companies.length}.`);
  }
  const company = companies[0];
  if (process.env.MARKETING_COMPANY_ID && String(company._id) !== process.env.MARKETING_COMPANY_ID) {
    throw new Error("MARKETING_COMPANY_ID does not match the only company in the development database.");
  }

  if (remove) {
    const result = await purge(company._id);
    console.log(JSON.stringify({ removed: result, company: company.companyName }, null, 2));
    return;
  }

  const { marketer, approver } = await actors(mongoose.connection.db);
  if (marketer.id === approver.id) {
    throw new Error("The development database needs two distinct actors to demonstrate plan approval.");
  }
  const approvedPlan = await ensurePlans(company._id, marketer, approver);
  const performance = await ensurePerformance(company._id, approvedPlan, approver);
  const audience = await ensureAudienceStory(company._id);
  const handovers = await ensureHandovers(company._id, marketer, approver);
  const trackingConfig = await ensureTracking(company._id, approver);
  const counts = {
    plans: await MarketingCampaignDraft.countDocuments({ companyId: company._id, utmCampaign: { $regex: `^${DEMO_PREFIX}` } }),
    deployments: await MarketingCampaignDeployment.countDocuments({ companyId: company._id, campaignDraftId: approvedPlan._id }),
    observations: await MarketingCampaignObservation.countDocuments({ companyId: company._id, deploymentId: performance.deployment._id }),
    people: await mongoose.connection.db.collection("marketing_identities").countDocuments({ companyId: company._id, gravPersonKey: { $regex: `^${DEMO_PREFIX}` } }),
    engagementEvents: await mongoose.connection.db.collection("marketing_intent_events").countDocuments({ companyId: company._id, sourceEventId: { $regex: `^${DEMO_PREFIX}` } }),
    handovers: await mongoose.connection.db.collection("marketing_prospect_handovers").countDocuments({ companyId: company._id, handoverRef: { $regex: "^MKT-DEMO-" } }),
  };
  console.log(JSON.stringify({
    company: company.companyName,
    inserted: counts,
    tracking: trackingConfig,
    story: { audience, handovers },
    externalCalls: 0,
    contentLibrary: "Not changed: it belongs to the separately authenticated content engine.",
    next: "Open Marketing Overview, Audiences, Campaigns, Handovers, and Integrations.",
  }, null, 2));
}

main()
  .catch((err) => {
    console.error(`Marketing demo seed failed: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
