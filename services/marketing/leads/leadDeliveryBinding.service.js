// services/marketing/leads/leadDeliveryBinding.service.js
//
// THE ADDRESS A CAMPAIGN'S LEADS ARRIVE AT.
//
// ── PREPARED BEFORE ANYTHING EXISTS IN GOOGLE ──────────────────────────────
// The order matters and it is not arbitrary. GRAV needs a binding before it
// creates a form, because configuring that form requires the webhook URL and
// the derived key — and both come from the binding. Creating the form first
// and binding afterwards would leave a window in which Google holds an address
// GRAV cannot resolve, and any lead submitted in that window is lost with
// nothing to explain it.
//
// ── THE COMPANY IS NEVER TAKEN FROM A CALLER ───────────────────────────────
// On preparation it comes from the authenticated marketer's membership. On
// delivery it comes out of the signed route token. A `companyId` in a request
// body is a company somebody chose, and this is the one service where choosing
// wrong means reading another tenant's enquiries.
"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");

const { fail } = require("../../storePurchase/errors");
const {
  MarketingLeadDeliveryBinding,
} = require("../../../models/CMS_Models/Marketing/MarketingLeadDeliveryBinding");
const tokens = require("./deliveryToken");
const keys = require("./leadWebhookKey");

const str = (v) => String(v ?? "").trim();

function assertCompany(companyId) {
  if (!companyId) {
    throw fail("TENANT_MEMBERSHIP_UNPROVEN", "A lead delivery address needs a company.");
  }
  return new mongoose.Types.ObjectId(String(companyId));
}

/* Keys sorted at every depth, so two logically identical commands produce one
   fingerprint whatever order their fields arrived in. */
function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(",")}}`;
}

const fingerprint = (command) => crypto
  .createHash("sha256").update(stableJson(command)).digest("hex");

/**
 * Prepare a delivery address for one approved plan revision.
 *
 * ── A RETRY RETURNS THE SAME ADDRESS; A CHANGED COMMAND CONFLICTS ──────────
 * Both halves matter. Returning the same binding for a repeated call is what
 * makes a network retry safe. Refusing a DIFFERENT command under the same key
 * is what stops a caller silently getting a binding for something other than
 * what they asked for — the failure that looks like success.
 */
async function prepare({ companyId, plan, deploymentId = null, idempotencyKey, actor, consentNotice = null } = {}) {
  const company = assertCompany(companyId);
  const key = str(idempotencyKey);
  if (!key) {
    throw fail("IDEMPOTENCY_KEY_REQUIRED",
      "Preparing a lead delivery address needs an idempotency key, so a retry cannot create a second one.");
  }
  if (!plan?._id) {
    throw fail("VALIDATION", "A lead delivery address needs the campaign plan it belongs to.");
  }

  /* ── THE PERMISSION WORDING IS PART OF THE COMMAND ───────────────────────
     So a retry that asks for a DIFFERENT notice conflicts rather than silently
     returning a binding recording other wording. */
  const notice = consentNotice && consentNotice.requested
    ? {
      requested: true,
      noticeId: str(consentNotice.noticeId),
      noticeVersion: str(consentNotice.noticeVersion),
      columnId: str(consentNotice.columnId),
      purpose: str(consentNotice.purpose) || "marketing",
      channel: str(consentNotice.channel) || "email",
    }
    : { requested: false, noticeId: "", noticeVersion: "", columnId: "", purpose: "marketing", channel: "email" };

  if (notice.requested && (!notice.noticeId || !notice.noticeVersion || !notice.columnId)) {
    /* A form that asks for permission without recording what it asked, in
       which version, under which answer, produces consent nobody can evidence
       later — which is worse than none, because it will be relied on. */
    throw fail("VALIDATION",
      "A form that asks for marketing permission must record the wording's identifier, its version, and which answer on the form is the permission question.",
      { field: "consentNotice" });
  }

  const command = {
    campaignDraftId: String(plan._id),
    approvedRevision: Number(plan.revision),
    deploymentId: deploymentId ? String(deploymentId) : null,
    channel: "google_ads",
    campaignType: "google_lead_form",
    consentNotice: notice,
  };
  const commandFingerprint = fingerprint(command);

  const existing = await MarketingLeadDeliveryBinding
    .findOne({ companyId: company, idempotencyKey: key });

  if (existing) {
    if (existing.commandFingerprint !== commandFingerprint) {
      /* ── THE SAME KEY FOR A DIFFERENT REQUEST ──────────────────────────
         Answering with the first binding would hand back an address for a
         different plan or revision than the caller named, and they would have
         no way to tell. */
      throw fail("IDEMPOTENCY_KEY_REUSED",
        "That idempotency key was already used to prepare a delivery address for a different campaign or revision.",
        { field: "idempotencyKey" });
    }
    return view(existing);
  }

  /* ── THE DERIVATION IDENTITY, GENERATED ONCE ─────────────────────────────
     Random rather than derived from the plan, so it cannot be guessed from
     anything public, and immutable on the schema because changing it would
     change the derived key and break a live form silently. */
  const bindingRef = `gld-${crypto.randomBytes(12).toString("hex")}`;

  try {
    const created = await MarketingLeadDeliveryBinding.create({
      companyId: company,
      bindingRef,
      campaignDraftId: plan._id,
      draftRef: str(plan.draftRef),
      approvedRevision: Number(plan.revision),
      deploymentId,
      channel: command.channel,
      campaignType: command.campaignType,
      secretVersion: keys.CURRENT_VERSION,
      state: "prepared",
      consentNotice: notice,
      idempotencyKey: key,
      commandFingerprint,
      preparedBy: actor ? { id: actor.id, name: str(actor.name), at: new Date() } : null,
    });
    return view(created);
  } catch (err) {
    /* Two requests racing on one key: the unique index settles it, and the
       loser reads the winner's row rather than failing. */
    if (err?.code === 11000) {
      const won = await MarketingLeadDeliveryBinding
        .findOne({ companyId: company, idempotencyKey: key });
      if (won) return view(won);
    }
    throw err;
  }
}

/**
 * Resolve a delivery address from the token Google posted to.
 *
 * ── THE ONLY PLACE A COMPANY COMES OUT OF A TOKEN ──────────────────────────
 * Verified signature first, then a selector carrying the company the token
 * named. Two independent checks: the signature catches a forged token before
 * any query runs, the selector catches anything that got past it.
 *
 * Returns `null` rather than throwing for an unknown or disabled binding, so
 * the route decides the HTTP answer — a refusal shape belongs to the boundary
 * that speaks to Google, not here.
 */
async function resolveForDelivery(deliveryToken, env = process.env) {
  let named;
  try {
    named = tokens.decodeDeliveryToken(deliveryToken, env);
  } catch {
    /* A forged, malformed or unknown token are one outcome on purpose.
       Distinguishing them would let somebody map which bindings exist. */
    return null;
  }

  const binding = await MarketingLeadDeliveryBinding.findOne({
    companyId: new mongoose.Types.ObjectId(named.companyId),
    bindingRef: named.bindingId,
  }).select("+providerFormId +providerCampaignId");

  if (!binding) return null;
  return binding;
}

/**
 * Record which Google objects this binding actually got.
 *
 * Learned after creation confirms what was made. A binding already carrying a
 * DIFFERENT form is refused rather than overwritten: two forms pointing at one
 * address means leads from both arrive as one campaign's, and the correlation
 * check that would have caught it has just been told the wrong answer.
 */
async function attachProviderIdentity({ companyId, bindingRef, providerFormId, providerCampaignId } = {}) {
  const company = assertCompany(companyId);
  const binding = await MarketingLeadDeliveryBinding
    .findOne({ companyId: company, bindingRef: str(bindingRef) })
    .select("+providerFormId +providerCampaignId");

  if (!binding) {
    throw fail("NOT_FOUND", "That delivery address could not be found.");
  }

  const form = str(providerFormId);
  const campaign = str(providerCampaignId);
  if (!/^\d{1,20}$/.test(form)) {
    throw fail("VALIDATION", "That is not a form identifier from the advertising channel.");
  }

  if (binding.providerFormId && binding.providerFormId !== form) {
    throw fail("CONFLICT",
      "This delivery address is already bound to a different form in the advertising channel.");
  }

  binding.providerFormId = form;
  if (campaign) binding.providerCampaignId = campaign;
  binding.correlationConfirmedAt = new Date();
  binding.state = "bound";
  await binding.save();

  return view(binding);
}

/** Stop accepting leads, without losing what already arrived. */
async function disable({ companyId, bindingRef, reason, actor } = {}) {
  const company = assertCompany(companyId);
  const binding = await MarketingLeadDeliveryBinding
    .findOne({ companyId: company, bindingRef: str(bindingRef) });

  if (!binding) throw fail("NOT_FOUND", "That delivery address could not be found.");

  const why = str(reason);
  if (!why) {
    throw fail("VALIDATION", "Turning off a delivery address needs a reason.", { field: "reason" });
  }

  binding.state = "disabled";
  binding.disabledReason = why;
  binding.disabledBy = actor ? { id: actor.id, name: str(actor.name), at: new Date() } : null;
  await binding.save();

  /* The row stays. A binding that stopped accepting leads is evidence about
     the leads that already arrived through it. */
  return view(binding);
}

/**
 * What the verifier needs, and nothing else.
 *
 * Deliberately not the key: the derivation identity and the generation, which
 * the key module turns into a comparison without the value ever existing in a
 * caller's variable.
 */
const derivationIdentity = (binding) => ({
  companyId: String(binding.companyId),
  bindingId: binding.bindingRef,
  version: binding.secretVersion,
});

/* The delivery token for a stored binding: the same value `view` publishes,
   for a reader (reconciliation) that must rebuild the address without
   preparing anything. A token is not a secret on its own — the key is. */
const deliveryTokenFor = (binding, env = process.env) => tokens.encodeDeliveryToken(
  { companyId: String(binding.companyId), bindingId: binding.bindingRef }, env,
);

function view(binding, env = process.env) {
  const deliveryToken = tokens.encodeDeliveryToken(
    { companyId: String(binding.companyId), bindingId: binding.bindingRef }, env,
  );
  return {
    ...binding.publicView(deliveryToken),
    /* Internal, for the caller that is about to configure Google. Never part
       of `publicView`, so a route that returns the public face cannot leak it
       by accident. */
    __bindingRef: binding.bindingRef,
    __id: binding._id,
  };
}

module.exports = {
  prepare,
  resolveForDelivery,
  attachProviderIdentity,
  disable,
  derivationIdentity,
  deliveryTokenFor,
  __internals: { fingerprint, stableJson },
};
