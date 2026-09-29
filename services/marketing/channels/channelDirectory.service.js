// services/marketing/channels/channelDirectory.service.js
//
// WHAT GRAV WILL SAY ABOUT A CHANNEL CONNECTION.
//
// ── CONFIGURED IS NOT CONNECTED ────────────────────────────────────────────
// A deployment holding five environment variables has configured Google Ads. It
// has not connected to it. The variables may be stale, the refresh token
// revoked, the developer token unapproved, the account closed. So `configured`
// and `available` are separate published facts, and `available` is only ever
// true because a read succeeded a moment ago.
//
// ── AND NEITHER IS A STATEMENT ABOUT CAMPAIGNS ─────────────────────────────
// The one thing this service must never imply is that advertising has stopped.
// A marketer reading "unavailable" is reading a fact about GRAV's connection.
// Their campaigns are running, spending money and being billed for the entire
// time GRAV cannot see them, and a screen that quietly renders unavailable as
// "no active campaigns" would tell somebody their advertising is off while their
// card is being charged. Every state in this file carries wording that says so.
//
// ── EACH CHANNEL FAILS ALONE ───────────────────────────────────────────────
// Three independent reads, each in its own try. Meta being down must not blank
// Google Ads, and one provider's outage must never cost a marketer the data the
// other two returned successfully.
"use strict";

const { fail } = require("../../storePurchase/errors");
const {
  MARKETING_CHANNELS, MARKETING_CHANNEL_CODES, CHANNEL_STATES, CHANNEL_CAPABILITIES,
  CAPABILITY_STATES, CHANNEL_ROLES, READ_STATES, channel: channelSpec,
} = require("../../../constants/marketingChannels");
const secrets = require("./channelSecrets");
const googleAds = require("./googleAdsClient");
const metaAds = require("./metaAdsClient");
const analytics = require("./googleAnalyticsClient");

const str = (v) => String(v ?? "").trim();

/* ── THE COMPANY GATE ───────────────────────────────────────────────────────
   The advertising credentials in this deployment belong to ONE company, exactly
   as the marketing engine's do. A second company asking is refused rather than
   shown a filtered view, because there is nothing to filter by: Google Ads has
   no GRAV company on its campaigns and never will.

   The alternative — serving every company the same account — is the failure this
   is here to prevent, and it is a silent one. */
function assertCompanyMayRead(companyId, env = process.env) {
  const configured = str(env.MARKETING_COMPANY_ID);
  if (!configured) {
    throw fail("MARKETING_COMPANY_NOT_CONFIGURED",
      "No company is connected to advertising channels in this deployment.");
  }
  if (str(companyId) !== configured) {
    throw fail("MARKETING_COMPANY_NOT_CONFIGURED",
      "Your company has no advertising channels connected here.");
  }
  return true;
}

/* Map a GRAV failure onto a public channel state. One table, so every channel
   reports the same failure the same way. */
function stateForFailure(err) {
  switch (str(err?.code)) {
    case "CHANNEL_NOT_CONFIGURED":
    case "CHANNEL_IDENTITY_NOT_CONFIGURED":
      return "not_configured";
    case "CHANNEL_ACCESS_REFUSED":
    /* Google Ads' three access parts. Each needs a person, never a retry,
       which is what `access_refused` tells a reader; the precise code travels
       beside it for the administrator. */
    case "CHANNEL_OAUTH_UNAVAILABLE":
    case "CHANNEL_API_ACCESS_UNAVAILABLE":
    case "CHANNEL_ACCOUNT_BINDING_UNAVAILABLE":
      return "access_refused";
    /* GRAV spoke a version the channel will not serve. Nothing could be read,
       and nobody at the channel can fix it — a GRAV release can. */
    case "CHANNEL_API_VERSION_REJECTED":
      return "unavailable";
    case "CHANNEL_RATE_LIMITED":
    case "CHANNEL_UNAVAILABLE":
    case "CHANNEL_MALFORMED_RESPONSE":
      return "unavailable";
    default:
      /* An unexpected failure is `unknown`, not `unavailable`. GRAV does not
         know the channel is down; GRAV knows its own code threw. */
      return "unknown";
  }
}

function capabilityForFailure(err) {
  const state = stateForFailure(err);
  if (state === "access_refused") return "refused";
  if (state === "not_configured") return "unknown";
  return "unavailable";
}

/* ── WHAT A MARKETER READS ───────────────────────────────────────────────────
   Business wording, and every failure sentence contains the same clause: this
   says nothing about whether the campaigns themselves are running. */
const PUBLIC_SUMMARY = Object.freeze({
  ready: "Connected. GRAV read from this channel successfully.",
  not_configured: "Not connected. Nobody has set this channel up in GRAV yet.",
  unavailable: "GRAV could not reach this channel just now. Your campaigns are unaffected — this is only about what GRAV can see.",
  access_refused: "This channel declined GRAV's access. Somebody needs to review the connection. Your campaigns are unaffected.",
  unknown: "GRAV has not checked this channel.",
});

/* The capability a partial connection is missing, in a marketer's words. */
const CAPABILITY_LABEL = Object.freeze({
  accountRead: "account access",
  campaignRead: "the campaign list",
  reportingRead: "performance reporting",
});

/**
 * The summary for a channel that works in part.
 *
 * Names the capability, names the consequence, and says the campaigns are
 * unaffected — because the one thing a marketer must not read into a GRAV
 * connection problem is that their advertising has stopped.
 */
function partialSummary(capabilities) {
  const broken = Object.entries(capabilities)
    .filter(([, state]) => state === "refused" || state === "unavailable")
    .map(([name]) => CAPABILITY_LABEL[name] || name);

  const list = broken.length === 1 ? broken[0] : `${broken.slice(0, -1).join(", ")} and ${broken.slice(-1)}`;
  return `Partly connected. GRAV can reach this channel but ${list} ${broken.length === 1 ? "is" : "are"} unavailable, so some screens will have no data. Your campaigns are unaffected — they may still be running and spending.`;
}

/**
 * The public state of one channel.
 *
 * @param {object} args
 * @param {boolean} [args.probe] perform live reads. False answers from
 *   configuration alone and reports `unknown` rather than claiming `ready`.
 */
async function inspectChannel(code, { probe = true, env = process.env, clients = {} } = {}) {
  const spec = channelSpec(code);
  if (!spec) throw fail("VALIDATION", "That is not a channel GRAV connects to.", { channel: code });

  const presence = secrets.presence(code, env);

  const capabilities = {
    accountRead: spec.supports.accounts ? "unknown" : "unsupported",
    campaignRead: spec.supports.campaigns ? "unknown" : "unsupported",
    reportingRead: spec.supports.performance ? "unknown" : "unsupported",
  };

  /* ── THE OWNED CHANNEL ───────────────────────────────────────────────────
     `email` has no external account, so there is nothing to connect and nothing
     to refuse. Its availability is the engine's — and it is CHECKED, not assumed
     from a configuration value being present. A base URL in an environment
     variable proves somebody typed a URL, which is not the same as the engine
     answering, and reporting `ready` on that basis told a marketer their email
     channel worked while every send failed.

     Nothing about the engine travels: not its name, its address, its variable
     names or its own health message. Only the GRAV-owned state. */
  if (code === "email") {
    const engineConfigured = Boolean(str(env.MAUTIC_BASE_URL));
    const now = new Date().toISOString();

    const emailRow = (state, summary, successAt = null) => ({
      channel: code, label: spec.label, role: spec.role,
      configured: engineConfigured,
      available: state === "ready",
      state,
      summary,
      capabilities,
      lastCheckedAt: now,
      lastSuccessfulCheckAt: successAt,
      /* No `missing` list ever: those variable names would name the engine. */
      diagnostics: null,
    });

    if (!engineConfigured) {
      return emailRow("not_configured", "Not connected. Marketing email is not set up in GRAV yet.");
    }
    if (!probe) {
      /* Configured, and unchecked. Not `ready`. */
      return emailRow("unknown", PUBLIC_SUMMARY.unknown);
    }

    try {
      const health = clients.engineHealth || require("../mauticHealth.service");
      const report = await health.check({ env });
      if (report?.healthy === true) {
        return emailRow("ready", "Connected. GRAV sends marketing email itself.", now);
      }
      /* A failed health read is `unknown`, not `unavailable`: the engine's own
         report distinguishes outage from misconfiguration and GRAV does not
         publish that distinction for this channel, so claiming "temporarily
         unavailable" would assert something unproved. The summary says what a
         marketer can act on, and the detail is in the server log. */
      return emailRow("unknown",
        "GRAV could not confirm that marketing email is working. Nothing has been sent in error — this is about what GRAV can verify.");
    } catch (err) {
      /* The engine's message is NOT attached. It names the product. */
      console.error("[marketing-channel] email availability check failed:",
        str(err?.code) || str(err?.message).slice(0, 200));
      return emailRow("unknown",
        "GRAV could not confirm that marketing email is working. Nothing has been sent in error — this is about what GRAV can verify.");
    }
  }

  const base = {
    channel: code, label: spec.label, role: spec.role,
    configured: presence.configured,
    available: false,
    state: presence.configured ? "unknown" : "not_configured",
    capabilities,
    lastCheckedAt: new Date().toISOString(),
    lastSuccessfulCheckAt: null,
  };

  if (!presence.configured) {
    return {
      ...base,
      summary: PUBLIC_SUMMARY.not_configured,
      /* Variable names, never values. Attached here and stripped for
         non-administrators by the route. */
      diagnostics: { missing: presence.missing, optionalMissing: presence.optionalMissing },
    };
  }

  if (!probe) {
    return { ...base, summary: PUBLIC_SUMMARY.unknown, diagnostics: null };
  }

  /* ── EVERY CAPABILITY IS PROVED BY ITS OWN READ ──────────────────────────
     No capability is ever inferred from another. The first version marked
     reporting confirmed whenever the campaign list succeeded, on the reasoning
     that both share a credential and an endpoint family — and sharing a
     credential is not sharing an authorisation.

     Google gates `metrics.*` behind an approved developer token that
     `campaign.*` does not require, so a test-token deployment lists campaigns
     and cannot report on them. Meta can refuse the insights edge while serving
     the campaigns edge, which is the normal state of a token issued before app
     review. In both cases the inference produced a `ready` channel and a
     permanently empty performance screen with nothing explaining it.

     So: three reads, three independent outcomes, each recorded as what it is. */
  const account = { value: null, failure: null };
  const failures = [];

  const probeCapability = async (name, supported, run) => {
    if (!supported) return;
    try {
      const out = await run();
      capabilities[name] = "confirmed";
      return out;
    } catch (err) {
      failures.push(err);
      capabilities[name] = capabilityForFailure(err);
      return null;
    }
  };

  const googleAdsClient = clients.googleAds || googleAds;
  const metaClient = clients.metaAds || metaAds;
  const analyticsClient = clients.analytics || analytics;

  account.value = await probeCapability("accountRead", spec.supports.accounts, () => (
    code === "google_ads" ? googleAdsClient.verifyAccount(env)
      : code === "meta_ads" ? metaClient.verifyAccount(env)
        : analyticsClient.verifyProperty(env)
  ));

  /* ── AND THE LATER PROBES STILL RUN WHEN THE ACCOUNT READ FAILED ─────────
     Only when the failure was NOT an authorisation one. A refused credential
     refuses every read, so three probes would produce three identical errors and
     three identical log lines. A timeout or a 500 is different: the account
     endpoint can be briefly unavailable while the campaign endpoint answers, and
     abandoning the remaining probes there would report a channel as less capable
     than it is. */
  const accountRefused = capabilities.accountRead === "refused";

  if (!accountRefused) {
    await probeCapability("campaignRead", spec.supports.campaigns, () => (
      code === "google_ads"
        ? googleAdsClient.listCampaigns({ pageSize: 1 }, env)
        : metaClient.listCampaigns({ pageSize: 1 }, env)
    ));

    await probeCapability("reportingRead", spec.supports.performance, () => {
      if (code === "google_ads") return googleAdsClient.verifyReporting(env);
      if (code === "meta_ads") return metaClient.verifyReporting(env);
      /* GA4's reporting probe is a one-day, one-row report. Small on purpose:
         this proves access, and a wide range would spend the property's quota to
         prove it. */
      const day = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
      return analyticsClient.campaignReport({ startDate: day, endDate: day, limit: 1 }, env);
    });
  } else {
    /* One refusal, applied to the reads it certainly also refuses — recorded as
       `refused` rather than left `unknown`, because GRAV does know. */
    if (spec.supports.campaigns) capabilities.campaignRead = "refused";
    if (spec.supports.performance) capabilities.reportingRead = "refused";
  }

  /* ── THE TOP-LEVEL STATE IS A FUNCTION OF ALL OF THEM ────────────────────
     `ready` only when every capability this release needs was independently
     confirmed. Anything confirmed alongside anything broken is
     `partially_ready`, which is a real state and not a rounding error. Nothing
     confirmed takes the worst failure's own state. */
  const required = Object.entries(capabilities).filter(([, v]) => v !== "unsupported");
  const confirmed = required.filter(([, v]) => v === "confirmed");
  const broken = required.filter(([, v]) => v === "refused" || v === "unavailable");

  let state;
  if (confirmed.length === required.length && required.length > 0) {
    state = "ready";
  } else if (confirmed.length > 0 && broken.length > 0) {
    state = "partially_ready";
  } else if (broken.length > 0) {
    state = stateForFailure(failures[0]);
  } else {
    state = "unknown";
  }

  const now = new Date().toISOString();
  return {
    ...base,
    /* `available` means every needed capability works. A partly connected
       channel is not available, and a client must not treat it as one. */
    available: state === "ready",
    state,
    summary: state === "partially_ready"
      ? partialSummary(capabilities)
      : PUBLIC_SUMMARY[state] || PUBLIC_SUMMARY.unknown,
    capabilities,
    lastCheckedAt: now,
    lastSuccessfulCheckAt: confirmed.length > 0 ? now : null,
    /* ── ADMIN-ONLY, AND STILL NO SECRETS ────────────────────────────────
       The GRAV failure code distinguishes authentication, permission, quota and
       malformed-response for an administrator, which is what makes a connection
       problem diagnosable. It carries no token, no variable value, no provider
       URL and no upstream body — those are in the server log, which only a
       technical operator reads.

       One code per failed capability, because a channel can fail two reads for
       two different reasons and one aggregate code would hide the second. */
    diagnostics: {
      failureCode: failures.length ? (str(failures[0].code) || "UNKNOWN") : null,
      failureAt: failures.length ? now : null,
      capabilityFailures: Object.fromEntries(
        broken.map(([name], i) => [name, str(failures[i]?.code) || str(failures[0]?.code) || "UNKNOWN"]),
      ),
      missing: presence.missing,
      optionalMissing: presence.optionalMissing,
    },
    /* Only for a channel whose account read succeeded, and only ever the
       account this deployment configured — never a discovery listing of every
       account the credential can see. */
    account: account.value
      ? {
        accountName: account.value.accountName || null,
        currency: account.value.currency || null,
        timeZone: account.value.timeZone || null,
      }
      : null,
  };
}

/**
 * Every channel, each read independently.
 *
 * A rejected probe never propagates: `Promise.allSettled` and a per-channel
 * catch, so one provider's outage cannot blank the other three.
 */
async function list({ companyId, probe = true, env = process.env, clients = {} } = {}) {
  assertCompanyMayRead(companyId, env);

  const results = await Promise.all(MARKETING_CHANNEL_CODES.map(async (code) => {
    try {
      return await inspectChannel(code, { probe, env, clients });
    } catch (err) {
      /* A GRAV-side fault, not a provider one. Reported as `unknown` for that
         channel, and the other three still answer. */
      console.error(`[marketing-channel] directory read failed for ${code}:`, str(err?.code) || str(err?.message).slice(0, 200));
      const spec = channelSpec(code);
      return {
        channel: code, label: spec?.label || code, role: spec?.role || null,
        configured: false, available: false, state: "unknown",
        summary: PUBLIC_SUMMARY.unknown,
        capabilities: { accountRead: "unknown", campaignRead: "unknown", reportingRead: "unknown" },
        lastCheckedAt: new Date().toISOString(),
        lastSuccessfulCheckAt: null,
        diagnostics: { failureCode: str(err?.code) || "UNKNOWN", missing: [], optionalMissing: [] },
        account: null,
      };
    }
  }));

  return {
    channels: results,
    checkedAt: new Date().toISOString(),
    /* True when the answer was computed from configuration alone. A client must
       not render `unknown` as a failure when this is true. */
    probed: probe,
  };
}

/**
 * The advertising accounts a channel's identity can see. Administrators only.
 *
 * Separate from `list` on purpose: it is the one operation that returns account
 * identifiers, and it exists so an administrator can confirm which account a
 * credential points at. An ordinary marketer never needs it and never gets it.
 */
async function accessibleAccounts({ companyId, channel, env = process.env } = {}) {
  assertCompanyMayRead(companyId, env);
  const spec = channelSpec(channel);
  if (!spec) throw fail("VALIDATION", "That is not a channel GRAV connects to.", { channel });
  if (!spec.supports.accounts) {
    throw fail("CHANNEL_UNSUPPORTED_OPERATION",
      `${spec.label} has no advertising accounts to list.`, { channel });
  }
  if (channel === "google_ads") return { channel, accounts: (await googleAds.accessibleAccounts(env)).map((id) => ({ accountId: id })) };
  if (channel === "meta_ads") return { channel, accounts: await metaAds.accessibleAccounts(env) };
  const property = await analytics.verifyProperty(env);
  return { channel, accounts: [{ accountId: property.propertyId, accountName: property.propertyName }] };
}

/** Served with the data so a client never hard-codes a label or a state. */
const vocabulary = Object.freeze({
  channels: MARKETING_CHANNELS.map((c) => ({ code: c.code, label: c.label, role: c.role })),
  roles: CHANNEL_ROLES,
  states: CHANNEL_STATES,
  capabilities: CHANNEL_CAPABILITIES,
  capabilityStates: CAPABILITY_STATES,
  readStates: READ_STATES,
});

module.exports = {
  assertCompanyMayRead,
  inspectChannel,
  list,
  accessibleAccounts,
  stateForFailure,
  vocabulary,
  PUBLIC_SUMMARY,
};
