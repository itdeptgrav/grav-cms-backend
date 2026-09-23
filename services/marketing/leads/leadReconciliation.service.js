// services/marketing/leads/leadReconciliation.service.js
//
// READING BACK FROM GOOGLE THE ENQUIRIES THE WEBHOOK NEVER DELIVERED.
//
// ── THE GAP ────────────────────────────────────────────────────────────────
// Google pushes each lead to the webhook and retries a failed push — but not
// for ever, and not at all if the address was wrong or GRAV was down for long
// enough. It also keeps every submission readable through its API for 60 days.
// This reads that record and brings in anything GRAV does not already hold.
//
// ── ONE PIPELINE, WHICHEVER DOOR ───────────────────────────────────────────
// Each row goes through the same normaliser, the same immutable ingestion, the
// same probable-duplicate check and the same processor as a webhook delivery:
//
//   webhook first, API later  → the API row is a duplicate by id; nothing new
//   API first, webhook later  → the webhook delivery is a duplicate by id
//   ids differ, same click     → the second is stored and held for a person
//
// ── THE WINDOW AND THE CURSOR (see the v25 notes in googleAdsClient.js) ────
// From where GRAV was last sure, less a day of overlap, never further back than
// Google's 60 days, to two days ahead — in whole days, the only literal Google
// documents for this field. Rows come back ordered by (time, id). A run stops
// after a bounded number of NEW enquiries or Google pages, and records the
// (time, id) of the last row it processed; the next run starts a day of
// overlap before that. GAQL has no OR, so the cursor cannot be a filter —
// rows at or before it are recognised by one id lookup per page and cost no
// write. If the last time GRAV was sure is further back than 60 days, the
// stretch in between is gone and the coverage says so.
//
// ── ONE RECONCILER ─────────────────────────────────────────────────────────
// The scheduler and the administrator's manual action both call
// `reconcileCompany`. There is no second code path to drift.
//
// ── OBSERVATION, NOT CREATION ──────────────────────────────────────────────
// Reads only. Nothing is created, paused or changed in the advertising
// account, and nothing here reaches Sales.
"use strict";

const mongoose = require("mongoose");

const { fail } = require("../../storePurchase/errors");
const { MarketingLeadDeliveryBinding } = require("../../../models/CMS_Models/Marketing/MarketingLeadDeliveryBinding");
const { MarketingAdvertisingLead } = require("../../../models/CMS_Models/Marketing/MarketingAdvertisingLead");
const { MarketingLeadProcessingReceipt } = require("../../../models/CMS_Models/Marketing/MarketingLeadProcessingReceipt");
const {
  MarketingLeadReconciliationState,
  coverageStateOf,
} = require("../../../models/CMS_Models/Marketing/MarketingLeadReconciliationState");
const { MarketingLeadReconciliationLease } = require("../../../models/CMS_Models/Marketing/MarketingLeadReconciliationLease");
const P = require("../../../constants/marketingLeadProcessing");
const { normalise, instantOf } = require("./googleLeadNormalisation");
const ingestion = require("./leadIngestion.service");
const processing = require("./leadProcessing.service");

const str = (v) => String(v ?? "").trim();
const oid = (v) => new mongoose.Types.ObjectId(String(v));
const DAY_MS = 24 * 60 * 60 * 1000;
const CHANNEL = "google_ads";
const R = P.RECOVERY;

/* Work owed by the internal processor, for the status read. */
const AWAITING_STAGES = P.STAGE_CODES.filter((c) => !P.TERMINAL_STAGES.includes(c));

/* A UTC calendar date. Widened by a day at each end by the caller, because the
   query is evaluated in the account's own timezone. */
const isoDate = (t) => new Date(t).toISOString().slice(0, 10);

/* (time, id) ordering. Ids are digit strings of any length, compared as
   numbers without ever becoming one. */
function compareIds(a, b) {
  const x = str(a).replace(/^0+/, "");
  const y = str(b).replace(/^0+/, "");
  if (x.length !== y.length) return x.length - y.length;
  return x < y ? -1 : x > y ? 1 : 0;
}
function laterThan(at, id, cursorAt, cursorId) {
  if (!cursorAt) return true;
  const a = new Date(at).getTime();
  const c = new Date(cursorAt).getTime();
  if (a !== c) return a > c;
  return compareIds(id, cursorId) > 0;
}

/* GRAV's failure code → the closed attention reason a screen may show. */
const ATTENTION_FOR_CODE = Object.freeze({
  CHANNEL_OAUTH_UNAVAILABLE: "oauth_unavailable",
  CHANNEL_API_ACCESS_UNAVAILABLE: "api_access_unavailable",
  CHANNEL_ACCOUNT_BINDING_UNAVAILABLE: "account_binding_unavailable",
  ADVERTISING_ACCOUNT_NOT_BOUND: "account_binding_unavailable",
  CHANNEL_ACCESS_REFUSED: "access_refused",
  CHANNEL_API_VERSION_REJECTED: "api_version_rejected",
  CHANNEL_NOT_CONFIGURED: "not_configured",
});
const attentionFor = (err) => ATTENTION_FOR_CODE[str(err?.code)] || "provider_unavailable";

/* The account the campaign lives in, and the client. Loaded lazily so a caller
   that injects them (tests) never touches either. */
function accountFor(companyId) {
  // eslint-disable-next-line global-require
  return require("../deployment/accountBinding.service").forDeployment({ companyId, channel: CHANNEL });
}
function defaultClient() {
  // eslint-disable-next-line global-require
  return require("../channels/googleAdsClient");
}

/* A binding is ACTIVE for reconciliation when Google has confirmed what was
   created — `bound` — and GRAV knows the campaign. Nothing else is asked
   about: without a campaign id there is no query that names only this
   binding's enquiries. */
const ACTIVE = { channel: CHANNEL, state: "bound", providerCampaignId: { $nin: ["", null] } };

/* ── ONE RUN PER COMPANY ────────────────────────────────────────────────────── */
async function acquireCompany({ companyId, now, startedBy }) {
  await MarketingLeadReconciliationLease.updateOne(
    { companyId },
    { $setOnInsert: { companyId } },
    { upsert: true },
  );
  return MarketingLeadReconciliationLease.findOneAndUpdate(
    { companyId, $or: [{ leaseUntil: null }, { leaseUntil: { $lte: now } }] },
    { $set: { leaseUntil: new Date(now.getTime() + R.LEASE_MS), startedBy, startedAt: now } },
    { new: true },
  );
}
const releaseCompany = (companyId, leaseId) => MarketingLeadReconciliationLease.updateOne(
  { _id: leaseId, companyId },
  { $set: { leaseUntil: null } },
);

const zeroCounts = () => ({ read: 0, recorded: 0, alreadyHeld: 0, heldForReview: 0, unreadable: 0 });

/** Bring one NEW row through the shared pipeline. */
async function ingestRow({ binding, row, companyId }) {
  const normalised = normalise({
    via: "retrieval",
    payload: row,
    rawIds: { campaign_id: row.campaign_id, form_id: row.form_id },
  });
  if (!normalised.ok) return "unreadable";

  /* The query already names the form; this is the second fence. A row from a
     different form is not this binding's enquiry, whatever it says. */
  const expectedForm = str(binding.providerFormId);
  const rowForm = str(normalised.lead.correlation?.formId);
  if (expectedForm && rowForm && expectedForm !== rowForm) return "unreadable";

  const out = await ingestion.record({ binding, lead: normalised.lead });
  if (out.outcome === ingestion.OUTCOMES.DUPLICATE) return "alreadyHeld";
  if (out.outcome !== ingestion.OUTCOMES.RECORDED) return "unreadable";

  /* The same processor the webhook uses. A failure here is recorded on the
     receipt and picked up by the internal sweep — never a reason to stop
     reading Google. */
  try {
    const processed = await processing.process({ companyId, submissionRef: out.submissionRef });
    if (processed?.stage === "needs_human_review") return "heldForReview";
  } catch (err) {
    console.error(`[lead-reconciliation] processing deferred to recovery: ${str(err?.code || "error")}`);
  }
  return "recorded";
}

/**
 * Reconcile one ACTIVE binding. Called only by `reconcileCompany`, under the
 * company lease.
 */
async function reconcileOne({ companyId, binding, now, google, acct }) {
  await MarketingLeadReconciliationState.updateOne(
    { companyId, bindingId: binding._id },
    { $setOnInsert: { companyId, bindingId: binding._id, channel: CHANNEL } },
    { upsert: true },
  );
  const state = await MarketingLeadReconciliationState
    .findOne({ companyId, bindingId: binding._id }).select("+cursorId");

  const run = zeroCounts();
  const set = {};
  let cursorAt = state.cursorAt;
  let cursorId = state.cursorId;

  try {
    /* ── THE WINDOW ─────────────────────────────────────────────────────── */
    const retentionStart = now.getTime() - R.PROVIDER_RETENTION_DAYS * DAY_MS;
    let base = state.coveredUntil
      ? state.coveredUntil.getTime()
      : new Date(binding.createdAt || now).getTime();
    /* A run that stopped part-way already processed everything up to its
       cursor. */
    if (cursorAt && cursorAt.getTime() > base) base = cursorAt.getTime();

    if (base < retentionStart) {
      /* ── THE GAP ────────────────────────────────────────────────────────
         Longer than Google keeps leads since GRAV was last sure. Whatever was
         submitted and never delivered in between cannot be recovered. */
      set.gapFrom = new Date(base);
      set.gapUntil = new Date(retentionStart);
      set.gapDetectedAt = now;
    }

    const fromInstant = Math.max(base - R.OVERLAP_MS, retentionStart);
    const fromDate = isoDate(fromInstant - DAY_MS);
    const toDate = isoDate(now.getTime() + 2 * DAY_MS);
    set.windowFromDate = fromDate;
    set.windowToDate = toDate;

    let pages = 0;
    let pageToken = null;
    let stoppedEarly = false;

    do {
      const page = await google.readLeadFormSubmissions({
        customerId: acct.externalAccountId,
        loginCustomerId: acct.loginAccountId || null,
        campaignId: binding.providerCampaignId,
        formId: binding.providerFormId || "",
        fromDate,
        toDate,
        pageToken,
      });
      pages += 1;

      /* ── WHAT GRAV ALREADY HOLDS, IN ONE LOOKUP ────────────────────────
         Scoped by company and channel, exactly like the unique index. */
      const ids = page.rows.map((r) => str(r.id)).filter(Boolean);
      const held = new Set((await MarketingAdvertisingLead.find({
        companyId, channel: CHANNEL, providerSubmissionId: { $in: ids },
      }).select("providerSubmissionId").lean()).map((d) => d.providerSubmissionId));

      for (const row of page.rows) {
        if (run.recorded + run.heldForReview >= R.MAX_NEW_ROWS_PER_RUN) { stoppedEarly = true; break; }
        run.read += 1;
        const outcome = held.has(str(row.id)) ? "alreadyHeld" : await ingestRow({ binding, row, companyId });
        run[outcome] += 1;

        const at = instantOf(row.submission_date_time);
        if (at && laterThan(at, row.id, cursorAt, cursorId)) {
          cursorAt = new Date(at);
          cursorId = str(row.id);
        }
      }

      pageToken = page.nextPageToken || null;

      /* ── DURABLE AFTER EVERY PAGE ─────────────────────────────────────
         Every row up to the cursor has been processed before it is saved, so
         a run that dies here re-reads at most this page. */
      await MarketingLeadReconciliationState.updateOne(
        { _id: state._id, companyId },
        { $set: { cursorAt, cursorId } },
      );
      if (stoppedEarly) break;
    } while (pageToken && pages < R.MAX_PAGES_PER_RUN);

    const complete = !stoppedEarly && !pageToken;
    Object.assign(set, {
      lastRunAt: now,
      lastStatus: complete ? "ok" : "partial",
      attentionReason: complete ? "" : "backlog",
      ...(complete ? { lastSuccessAt: now, coveredUntil: now } : {}),
      lastRun: run,
    });
  } catch (err) {
    /* The code only. A Google error body names accounts and campaigns. */
    console.error(`[lead-reconciliation] binding run failed: ${str(err?.code || "error")}`);
    Object.assign(set, {
      lastRunAt: now,
      lastStatus: "failed",
      attentionReason: attentionFor(err),
      lastRun: run,
    });
  } finally {
    const inc = Object.fromEntries(Object.entries(run).map(([k, v]) => [`totals.${k}`, v]));
    await MarketingLeadReconciliationState.updateOne(
      { _id: state._id, companyId },
      { $set: set, $inc: inc },
    );
  }
  return { ...run, status: set.lastStatus, attentionReason: set.attentionReason || null };
}

/* Records why a whole company could not be checked on every active binding,
   so the status read says so instead of going quiet. */
async function markCompanyUnavailable({ companyId, bindings, now, reason }) {
  for (const b of bindings) {
    await MarketingLeadReconciliationState.updateOne(
      { companyId, bindingId: b._id },
      {
        $setOnInsert: { companyId, bindingId: b._id, channel: CHANNEL },
        $set: { lastRunAt: now, lastStatus: "unavailable", attentionReason: reason },
      },
      { upsert: true },
    );
  }
}

/**
 * Reconcile every ACTIVE lead form in one company. The ONE reconciler: the
 * scheduler and the manual action both come here.
 *
 * @param {object}   args
 * @param {ObjectId} args.companyId
 * @param {"scheduler"|"manual"} [args.startedBy]
 * @param {Date}     [args.now]
 * @param {object}   [args.client]   the Google client (injectable for tests)
 * @param {object}   [args.account]  { externalAccountId, loginAccountId } (tests)
 * @returns {Promise<{ran:boolean, busy?:boolean, bindings:number, counts:object, status:object}>}
 */
async function reconcileCompany({ companyId, startedBy = "manual", now = new Date(), client = null, account = null } = {}) {
  if (!companyId) throw fail("TENANT_MEMBERSHIP_UNPROVEN", "Reconciliation needs a company.");
  const company = oid(companyId);

  const lease = await acquireCompany({ companyId: company, now, startedBy });
  if (!lease) {
    return { ran: false, busy: true, bindings: 0, counts: zeroCounts(), status: await status({ companyId: company, now }) };
  }

  const counts = zeroCounts();
  let visited = 0;
  try {
    const bindings = await MarketingLeadDeliveryBinding.find({ companyId: company, ...ACTIVE })
      .select("+providerCampaignId +providerFormId")
      .sort({ createdAt: 1 })
      .limit(R.MAX_BINDINGS_PER_RUN);

    if (bindings.length) {
      let acct = account;
      if (!acct) {
        try {
          acct = await accountFor(company);
        } catch (err) {
          await markCompanyUnavailable({ companyId: company, bindings, now, reason: attentionFor(err) });
          acct = null;
        }
      }

      if (acct) {
        const google = client || defaultClient();
        for (const binding of bindings) {
          const out = await reconcileOne({ companyId: company, binding, now, google, acct });
          visited += 1;
          for (const k of Object.keys(counts)) counts[k] += out[k] || 0;
          /* An access problem is the same for every binding in the account.
             Asking again for each one would only repeat the refusal. */
          if (out.status === "failed" && out.attentionReason && out.attentionReason !== "provider_unavailable") {
            await markCompanyUnavailable({
              companyId: company, bindings: bindings.slice(visited), now, reason: out.attentionReason,
            });
            break;
          }
        }
      }
    }
  } finally {
    await releaseCompany(company, lease._id);
  }

  return { ran: true, bindings: visited, counts, status: await status({ companyId: company, now }) };
}

/* ── WHAT A SCREEN MAY SEE ──────────────────────────────────────────────────
   Keyed by the draft reference Marketing already knows. Never the binding's
   own reference (the webhook key is derived from it), a database id, a
   provider id, a cursor or a token. */
function bindingView(binding, stateDoc, now) {
  const correlated = binding.state === "bound" && Boolean(str(binding.providerCampaignId));
  const code = !correlated
    ? "recovery_unavailable"
    : stateDoc ? coverageStateOf(stateDoc, now) : "recovery_never_run";
  const label = P.COVERAGE_STATES.find((s) => s.code === code);
  const view = stateDoc ? stateDoc.publicView({ now }) : {
    checkedThrough: null, lastCheckedAt: null, checkedBackTo: null, unrecoverableBefore: null,
    recoveredEnquiries: 0, duplicatesIgnored: 0, attentionReason: null,
  };
  const attention = !correlated ? "campaign_not_created" : view.attentionReason;
  const reason = attention ? P.ATTENTION_REASONS.find((r) => r.code === attention) : null;
  return {
    draftRef: binding.draftRef,
    ...view,
    state: code,
    label: label?.label || "",
    means: label?.means || "",
    attentionReason: reason ? { code: reason.code, label: reason.label, means: reason.means } : null,
  };
}

/**
 * The company's recovery status: coverage per lead form and the company-wide
 * counts a marketer asks about. Company-scoped on every selector.
 */
async function status({ companyId, now = new Date() } = {}) {
  if (!companyId) throw fail("TENANT_MEMBERSHIP_UNPROVEN", "Coverage needs a company.");
  const company = oid(companyId);

  const bindings = await MarketingLeadDeliveryBinding.find({
    companyId: company, channel: CHANNEL, state: { $ne: "disabled" },
  }).select("+providerCampaignId").sort({ createdAt: 1 });
  const states = await MarketingLeadReconciliationState.find({
    companyId: company, bindingId: { $in: bindings.map((b) => b._id) },
  });
  const byBinding = new Map(states.map((st) => [String(st.bindingId), st]));

  const [recorded, awaiting, held] = await Promise.all([
    MarketingAdvertisingLead.countDocuments({ companyId: company, channel: CHANNEL, classification: "production" }),
    MarketingLeadProcessingReceipt.countDocuments({
      companyId: company, contractVersion: P.CONTRACT_VERSION, stage: { $in: AWAITING_STAGES },
    }),
    MarketingLeadProcessingReceipt.countDocuments({
      companyId: company, contractVersion: P.CONTRACT_VERSION, stage: "needs_human_review",
    }),
  ]);

  const leadForms = bindings.map((b) => bindingView(b, byBinding.get(String(b._id)), now));
  return {
    retentionDays: R.PROVIDER_RETENTION_DAYS,
    /* Nothing older than this can be brought back by any check, today. */
    recoverableFrom: new Date(now.getTime() - R.PROVIDER_RETENTION_DAYS * DAY_MS),
    leadsRecorded: recorded,
    duplicatesIgnored: leadForms.reduce((n, v) => n + (v.duplicatesIgnored || 0), 0),
    awaitingProcessing: awaiting,
    heldForReview: held,
    leadForms,
  };
}

/** Coverage per lead form only (kept for callers written against 3C). */
async function coverage({ companyId, now = new Date() } = {}) {
  return (await status({ companyId, now })).leadForms;
}

/**
 * Which companies have something reconciliation could check. The only
 * cross-company question asked; every read and write after it is scoped.
 */
async function companiesWithActiveBindings() {
  return (await MarketingLeadDeliveryBinding.distinct("companyId", ACTIVE)).map(String);
}

module.exports = {
  reconcileCompany,
  status,
  coverage,
  companiesWithActiveBindings,
  ACTIVE_BINDING_FILTER: ACTIVE,
  __internals: { compareIds, laterThan, isoDate, ingestRow, attentionFor, reconcileOne },
};
