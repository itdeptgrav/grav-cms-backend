// services/marketing/deployment/accountBinding.service.js
//
// BINDING A GRAV COMPANY TO AN ADVERTISING ACCOUNT, AND KEEPING SECRETS OUT.
//
//   bind()        record an account, verified against what the connection sees
//   verify()      read the account again and record what came back
//   revoke()      withdraw the binding; nothing new may be created after it
//   forDeployment() the one read a write path is allowed to make
//   current()     the operator's view, safe to serialise
//
// ── THE ACCOUNT IS NEVER INFERRED ──────────────────────────────────────────
// `bind()` takes the account id from the caller and checks it against the list
// the credential can actually reach. It does NOT read `GOOGLE_ADS_CUSTOMER_ID`
// and offer it as a default, because a default is a choice nobody made, and the
// whole point of a binding is that somebody made one.
//
// The env variable keeps its job on the read surfaces, which shipped with it.
// Nothing on a write path reads it: `forDeployment()` is the only account source
// the orchestrator has, and it throws rather than falling back.
//
// ── AND A CREDENTIAL CANNOT GET IN ─────────────────────────────────────────
// Three independent barriers, because one is a single point of failure:
//   1. `assertBindable` accepts only the allow-listed field names.
//   2. It then checks every accepted VALUE for a secret's shape, so a developer
//      token pasted into `note` is refused rather than stored under a name that
//      looks harmless.
//   3. The model is `strict: "throw"`, so anything that got past both is a
//      write error rather than a silently dropped field.
"use strict";

const mongoose = require("mongoose");

const { fail } = require("../../storePurchase/errors");
const Binding = require("../../../models/CMS_Models/Marketing/MarketingAdvertisingAccountBinding");
const googleAds = require("../channels/googleAdsClient");
const metaAds = require("../channels/metaAdsClient");
const {
  BINDING_STATES,
  BINDING_STATES_ALLOWING_DEPLOYMENT,
  BINDING_FIELDS,
  BINDING_FORBIDDEN_HINTS,
  CHANNEL_BINDING_FIELDS,
  callerFieldsFor,
  foreignFieldOwner,
  misplacedFieldMessage,
} = require("../../../constants/marketingGoogleSearchDeployment");
const { DEPLOYMENT_CHANNEL_CODES } = require("../../../models/CMS_Models/Marketing/MarketingCampaignDeployment");

const str = (v) => String(v ?? "").trim();

/* ── WHAT THIS FILE KNOWS ABOUT EACH CHANNEL, AND NOTHING MORE ──────────────
   Binding is genuinely provider-neutral: a company, an account somebody chose,
   what the account said about itself, and who decided. Two things differ per
   channel and both are DATA rather than branches in the code below:

     what an account identifier looks like, because a value that parses as one
     channel's id and not the other's must be refused rather than stored; and

     which adapter answers "describe this account", because that is the read
     that proves GRAV is pointed where somebody meant.

   Kept as a table so adding a channel is an entry, not an edit to `bind`,
   `verify`, `revoke` and `forDeployment` — four places that would drift. */
const CHANNEL_ADAPTERS = Object.freeze({
  google_ads: Object.freeze({
    /* The interface shows `123-456-7890`; the API takes `1234567890`. Both are
       accepted and one is stored, because two rows that are the same account
       must not be able to look different. A value that is neither is refused
       rather than stripped down to whatever digits it contains — `acct
       123-456-7890 (old)` reduced to digits is a plausible account number
       nobody typed. */
    pattern: /^\d{3}-?\d{3}-?\d{4}$/,
    shape: "ten digits, shown as 123-456-7890",
    normalise: (raw) => raw.replace(/-/g, ""),
    client: () => googleAds,
    /* A second account number, for Google's manager account. */
    secondaryField: "loginAccountId",
  }),
  meta_ads: Object.freeze({
    /* Meta shows `act_1234567890` and its API takes the same. The prefix is
       part of the identifier, not decoration: a bare number is an ambiguous
       thing in the Graph API — it could be a page, a business or a pixel — and
       storing one would make the binding's meaning depend on context. */
    pattern: /^(act_)?\d{6,20}$/,
    shape: "act_ followed by the account number, as Meta shows it",
    normalise: (raw) => (raw.startsWith("act_") ? raw : `act_${raw}`),
    client: () => metaAds,
    /* Meta's second identifier is the business the account sits in. */
    secondaryField: "businessId",
  }),
});

const BINDABLE_CHANNELS = Object.freeze(Object.keys(CHANNEL_ADAPTERS));

/**
 * The stored form of one account identifier, or a refusal naming its shape.
 *
 * Per channel, because an identifier that is valid for one and not the other is
 * a caller who has confused two accounts — and silently accepting it would bind
 * a company to something that does not exist.
 */
function normaliseAccountId(value, field, channel) {
  const raw = str(value);
  const adapter = CHANNEL_ADAPTERS[str(channel)];
  if (!adapter) {
    throw fail("VALIDATION", "GRAV does not bind accounts in that channel.", { field: "channel" });
  }
  if (!raw) {
    throw fail("VALIDATION",
      "An advertising account identifier is needed. GRAV will not choose one for you.",
      { field });
  }
  if (!adapter.pattern.test(raw)) {
    throw fail("VALIDATION",
      `That is not an advertising account identifier for this channel. It is ${adapter.shape}.`,
      { field });
  }
  return adapter.normalise(raw);
}

/* The Google-specific name kept as a thin alias: it is exported, and three
   suites call it. Behaviour identical. */
const normaliseGoogleAccountId = (value, field) => normaliseAccountId(value, field, "google_ads");

/* ── A SECRET, BY SHAPE RATHER THAN BY NAME ─────────────────────────────────
   The field allow-list stops `refreshToken`. This stops the same value arriving
   as `note`. Two checks: a name that reads like a credential, and a value long
   enough and random-looking enough to be one.

   Deliberately crude, and deliberately erring towards refusal on a free-text
   note. A refused note costs somebody a retype; a stored refresh token is in
   every backup for ever. */
const looksLikeSecretName = (name) => {
  const flat = str(name).toLowerCase().replace(/[^a-z]/g, "");
  return BINDING_FORBIDDEN_HINTS.some((hint) => flat.includes(hint));
};

const looksLikeSecretValue = (value) => {
  const v = str(value);
  if (v.length < 24) return false;
  /* Google refresh tokens start `1//`, OAuth client secrets `GOCSPX-`, and a
     long unbroken run of token characters is what every bearer credential looks
     like. A sentence has spaces; a token does not. */
  if (/^1\/\//.test(v) || /^GOCSPX-/.test(v) || /^ya29\./.test(v) || /^EAA[A-Za-z0-9]{20,}/.test(v)) return true;
  return /^[A-Za-z0-9_\-.~+/=]{32,}$/.test(v);
};

function assertNoSecretShapedValue(name, value) {
  if (looksLikeSecretValue(value)) {
    throw fail("VALIDATION",
      "That looks like a credential. Advertising credentials belong in the deployment's own secret configuration and are never stored against a company. Nothing has been saved.",
      { field: name });
  }
}

/**
 * The supplied fields, or a refusal naming the offending one.
 *
 * An allow-list, evaluated over the caller's OWN keys rather than over the list
 * of permitted ones, so an extra key is noticed instead of ignored.
 */
function assertBindable(payload, channel = "") {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw fail("VALIDATION", "A binding needs an account to bind to.", { field: "binding" });
  }

  /* ── THE CHANNEL'S OWN FIELD CONTRACT ─────────────────────────────────────
     When a channel is known, the caller's fields are that channel's, not the
     union of every channel's. Google's second identifier is a manager account
     and Meta's is a business; each silently accepting the other's stores a
     number nothing will ever read, and the binding looks complete while being
     wrong in a way only a misplaced campaign reveals.

     With no channel (an internal caller checking shape alone) this falls back
     to the full record contract, which is what it always did. */
  const spec = CHANNEL_BINDING_FIELDS[str(channel)];
  const allowed = spec ? callerFieldsFor(str(channel)) : BINDING_FIELDS;

  for (const key of Object.keys(payload)) {
    if (looksLikeSecretName(key)) {
      throw fail("VALIDATION",
        "A credential cannot be stored against a company. Advertising credentials live in the deployment's own secret configuration; this record holds only the account number and its labels.",
        { field: key });
    }
    if (!allowed.includes(key)) {
      /* A field that belongs to a DIFFERENT channel gets its own message. It is
         the likeliest mistake and the least obvious one, so the refusal says
         which channel it belongs to rather than "unknown field". */
      const otherChannel = spec ? foreignFieldOwner(key, str(channel)) : "";
      if (otherChannel) {
        throw fail("VALIDATION", misplacedFieldMessage(key, str(channel)),
          { field: key, belongsTo: otherChannel });
      }
      throw fail("VALIDATION",
        `A binding records only: ${allowed.join(", ")}.`,
        { field: key });
    }
    assertNoSecretShapedValue(key, payload[key]);
  }

  for (const key of (spec ? spec.required : [])) {
    if (!str(payload[key])) {
      throw fail("VALIDATION", `A binding needs ${key}.`, { field: key });
    }
  }
  return payload;
}

function assertChannel(channel) {
  const code = str(channel);
  if (!DEPLOYMENT_CHANNEL_CODES.includes(code)) {
    throw fail("VALIDATION",
      `An advertising account belongs to one of: ${DEPLOYMENT_CHANNEL_CODES.join(", ")}.`,
      { field: "channel" });
  }
  if (!BINDABLE_CHANNELS.includes(code)) {
    throw fail("CAMPAIGN_DEPLOYMENT_NOT_BUILT",
      `GRAV cannot prepare campaigns in that channel yet, so there is nothing for a binding to do. It can bind: ${BINDABLE_CHANNELS.join(", ")}.`,
      { field: "channel" });
  }
  return code;
}

function assertActor(actor) {
  const id = actor?.id;
  const name = str(actor?.name);
  if (!id || !mongoose.Types.ObjectId.isValid(String(id)) || !name) {
    throw fail("VALIDATION",
      "Binding an advertising account is a decision that carries a name. GRAV needs to know who made it.",
      { field: "actor" });
  }
  return { id: new mongoose.Types.ObjectId(String(id)), name, role: str(actor?.role), at: new Date() };
}

/* ── WHAT THE ACCOUNT ITSELF SAID ───────────────────────────────────────────
   One read, against the account the caller NAMED, using the credential. Three
   outcomes and they are different facts:

     reachable   — GRAV read the account
     not_listed  — the credential cannot see it at all
     unreachable — the connection failed, which is not the same as a wrong id

   The third is why this does not collapse to a boolean: a provider outage would
   otherwise mark a correct binding as wrong, and somebody would rebind to fix a
   problem that was never the binding. */
async function probeAccount({ channel, externalAccountId, loginAccountId, businessId }, deps) {
  const adapter = CHANNEL_ADAPTERS[channel];
  /* A per-channel injection key, so one test can hand in a fake for one channel
     without silencing the other. `googleAds` is the name three existing suites
     already use and it keeps working. */
  const client = (channel === "meta_ads" ? deps.metaAds : deps.googleAds) || adapter.client();
  try {
    const accessible = await client.accessibleAccounts();
    /* `accessibleAccounts` lists only DIRECTLY accessible accounts. An account
       reached through a manager or a business is not in it, which is why a miss
       here is not fatal on its own — the account read below is the real test. */
    const directlyListed = accessible.includes(externalAccountId);

    const account = await client.describeAccount({
      /* Both adapters take the account under the name their own API uses, and
         both ignore the key that is not theirs. */
      customerId: externalAccountId,
      accountId: externalAccountId,
      loginCustomerId: loginAccountId || null,
      businessId: businessId || null,
    });

    /* ── THE ACCOUNT IT ANSWERED ABOUT IS THE ACCOUNT THAT WAS ASKED FOR ──
       The whole point of a binding is that somebody CHOSE an account. A client
       that answered about a different one — because the credential defaults to
       its own, because an id was normalised differently at the two ends — would
       bind a company to whichever account the connection preferred.

       Compared on the normalised form, so `act_123` and `123` are the same
       account and `123` and `456` are not. */
    const answered = str(account?.accountId);
    if (answered && adapter.normalise(answered) !== adapter.normalise(externalAccountId)) {
      console.error(`[marketing-channel] ${channel} account.describe answered about a different account`);
      return {
        outcome: "identity_mismatch",
        reasonCode: "ACCOUNT_IDENTITY_MISMATCH",
        directlyListed,
        account: null,
      };
    }

    return {
      outcome: "reachable",
      reasonCode: "",
      directlyListed,
      account,
    };
  } catch (err) {
    /* ── A REFUSAL IS NOT AN OUTAGE ─────────────────────────────────────────
       `CHANNEL_ACCESS_REFUSED` means the credential cannot have this account.
       Anything else means GRAV could not find out, and a binding is left
       `unverified` rather than declared wrong. */
    const code = str(err?.code);
    if (code === "CHANNEL_ACCESS_REFUSED" || code === "NOT_FOUND") {
      return { outcome: "not_listed", reasonCode: "ACCOUNT_NOT_ACCESSIBLE", directlyListed: false, account: null };
    }
    return { outcome: "unreachable", reasonCode: code || "CHANNEL_UNAVAILABLE", directlyListed: false, account: null };
  }
}

const verificationFrom = (probe) => ({
  at: new Date(),
  outcome: probe.outcome,
  reasonCode: probe.reasonCode,
  observedAccountName: str(probe.account?.accountName),
  observedCurrency: str(probe.account?.currency),
  observedTimeZone: str(probe.account?.timeZone),
  observedIsManager: typeof probe.account?.isManager === "boolean" ? probe.account.isManager : null,
  observedStatus: str(probe.account?.status),
});

const stateFor = (probe) => {
  if (probe.outcome === "reachable") return "verified";
  /* An account the credential cannot see, and one that answered about somebody
     else, are both "GRAV cannot use this" rather than "GRAV has not checked". */
  if (probe.outcome === "not_listed" || probe.outcome === "identity_mismatch") return "unreachable";
  return "unverified";
};

/**
 * Record which advertising account this company's campaigns are created in.
 *
 * Rebinding replaces the live binding rather than adding a second: the old row
 * is withdrawn with a reason, so the history says an account was changed and
 * by whom, instead of two live rows disagreeing.
 */
async function bind({ companyId, channel, payload, actor }, deps = {}) {
  const code = assertChannel(channel);
  const supplied = assertBindable(payload, code);
  const by = assertActor(actor);

  const externalAccountId = normaliseAccountId(supplied.externalAccountId, "externalAccountId", code);
  /* Each channel's secondary identifier is read only for the channel it belongs
     to. `assertBindable` has already refused the other one by name; this makes
     the read itself incapable of picking it up. */
  const loginAccountId = code === "google_ads" && str(supplied.loginAccountId)
    ? normaliseAccountId(supplied.loginAccountId, "loginAccountId", code)
    : "";
  /* Meta's business identifier. A plain number, and never normalised into an
     `act_` id: a business and an ad account are different objects. */
  const businessId = code === "meta_ads" ? str(supplied.businessId) : "";
  if (businessId && !/^\d{6,20}$/.test(businessId)) {
    throw fail("VALIDATION", "That is not a business identifier for this channel.", { field: "businessId" });
  }

  if (loginAccountId && loginAccountId === externalAccountId) {
    throw fail("VALIDATION",
      "The manager account and the advertising account cannot be the same account.",
      { field: "loginAccountId" });
  }

  const probe = await probeAccount({ channel: code, externalAccountId, loginAccountId, businessId }, deps);

  /* ── A BINDING GRAV COULD NOT READ IS NOT REFUSED, IT IS RECORDED ────────
       Refusing would make a binding impossible during an outage, and an operator
       would work around it by editing the environment — which is exactly the
       configuration this record replaces. It is stored `unverified` or
       `unreachable` instead, and `forDeployment` refuses to create in it. */
  const existing = await Binding.findOne({
    companyId, channel: code, state: { $in: ["unverified", "verified", "unreachable"] },
  });

  if (existing) {
    existing.state = "revoked";
    existing.revokedBy = by;
    existing.revokedReason = "Replaced by a new binding.";
    existing.revision += 1;
    await existing.save();
  }

  const doc = await Binding.create({
    companyId,
    channel: code,
    externalAccountId,
    externalAccountName: str(supplied.externalAccountName) || str(probe.account?.accountName),
    loginAccountId,
    businessId,
    /* Read from the account, never taken from the caller: a currency somebody
       typed is a claim, and the budget check has to be against the account's
       own billing currency. */
    currency: str(probe.account?.currency),
    timeZone: str(probe.account?.timeZone),
    note: str(supplied.note),
    state: stateFor(probe),
    boundBy: by,
    lastVerification: verificationFrom(probe),
  });

  return { binding: publicBinding(doc), replaced: Boolean(existing) };
}

/** Read the bound account again and record what came back. */
async function verify({ companyId, channel, actor }, deps = {}) {
  const code = assertChannel(channel);
  assertActor(actor);

  const doc = await Binding.findOne({
    companyId, channel: code, state: { $in: ["unverified", "verified", "unreachable"] },
  });
  if (!doc) {
    throw fail("NOT_FOUND",
      "No advertising account is bound to this company yet, so there is nothing to verify.",
      { field: "binding" });
  }

  const probe = await probeAccount({
    channel: code,
    externalAccountId: doc.externalAccountId,
    loginAccountId: doc.loginAccountId,
    businessId: doc.businessId,
  }, deps);

  doc.state = stateFor(probe);
  doc.lastVerification = verificationFrom(probe);
  if (probe.account) {
    doc.externalAccountName = str(probe.account.accountName) || doc.externalAccountName;
    doc.currency = str(probe.account.currency) || doc.currency;
    doc.timeZone = str(probe.account.timeZone) || doc.timeZone;
  }
  doc.revision += 1;
  await doc.save();

  return { binding: publicBinding(doc) };
}

/** Withdraw the binding. Nothing new can be created in that account afterwards. */
async function revoke({ companyId, channel, reason, actor }) {
  const code = assertChannel(channel);
  const by = assertActor(actor);

  const doc = await Binding.findOneAndUpdate(
    { companyId, channel: code, state: { $in: ["unverified", "verified", "unreachable"] } },
    {
      $set: {
        state: "revoked",
        revokedBy: by,
        revokedReason: str(reason).slice(0, 300),
      },
      $inc: { revision: 1 },
    },
    { new: true },
  );

  if (!doc) {
    throw fail("NOT_FOUND", "There is no advertising account bound to this company to withdraw.", { field: "binding" });
  }
  return { binding: publicBinding(doc) };
}

/**
 * The account a write path may create in — or a refusal saying why not.
 *
 * ── THE ONLY ACCOUNT SOURCE ON A WRITE PATH ────────────────────────────────
 * There is no fallback here, deliberately. A `?? process.env.GOOGLE_ADS_CUSTOMER_ID`
 * on this line would undo the entire record: every refusal below would become a
 * create in whatever account the environment named.
 */
async function forDeployment({ companyId, channel }) {
  const code = assertChannel(channel);

  const doc = await Binding.findOne({
    companyId, channel: code, state: { $in: ["unverified", "verified", "unreachable"] },
  }).lean();

  if (!doc) {
    throw fail("ADVERTISING_ACCOUNT_NOT_BOUND",
      "No advertising account is bound to this company. Somebody has to choose which account these campaigns are created in before anything can be created.",
      { field: "binding" });
  }

  if (!BINDING_STATES_ALLOWING_DEPLOYMENT.includes(doc.state)) {
    const label = BINDING_STATES.find((s) => s.code === doc.state);
    throw fail("ADVERTISING_ACCOUNT_NOT_BOUND",
      `The bound advertising account is ${(label?.label || doc.state).toLowerCase()}. ${label?.means || ""} Nothing can be created in it until that is resolved.`.trim(),
      { field: "binding" });
  }

  return {
    bindingId: doc._id,
    channel: doc.channel,
    externalAccountId: doc.externalAccountId,
    externalAccountName: doc.externalAccountName,
    loginAccountId: doc.loginAccountId || null,
    businessId: doc.businessId || null,
    currency: doc.currency,
    timeZone: doc.timeZone,
    /* ── THE VERSION OF THE DECISION ──────────────────────────────────────
       Part of every downstream fence. A rebind — even to the same account
       number, after a failed verification — is a new decision, and a preflight
       resolved against the old one belongs to the old one. */
    bindingRevision: doc.revision,
    accountCapabilities: doc.accountCapabilities || null,
    verifiedAt: doc.lastVerification?.at || null,
  };
}

/* ── THE OPERATOR'S VIEW ────────────────────────────────────────────────────
   Built field by field. A spread of the document would put whatever a future
   field turns out to be on the wire the day it is added, which is how a value
   that should not be public becomes public without anybody editing this line. */
function publicBinding(doc) {
  const meaning = BINDING_STATES.find((s) => s.code === doc.state) || null;
  return {
    channel: doc.channel,
    /* The account number IS shown: somebody confirming a binding has to be able
       to check it against the advertising interface, and it is not a secret —
       it is on every invoice. */
    externalAccountId: doc.externalAccountId,
    externalAccountName: doc.externalAccountName || null,
    loginAccountId: doc.loginAccountId || null,
    businessId: doc.businessId || null,
    currency: doc.currency || null,
    timeZone: doc.timeZone || null,
    accountStatus: doc.accountStatus || null,
    accountCapabilities: doc.accountCapabilities || null,
    note: doc.note || "",
    state: doc.state,
    stateLabel: meaning?.label || doc.state,
    stateMeans: meaning?.means || "",
    mayDeploy: BINDING_STATES_ALLOWING_DEPLOYMENT.includes(doc.state),
    boundBy: doc.boundBy ? { name: doc.boundBy.name, role: doc.boundBy.role, at: doc.boundBy.at } : null,
    revokedBy: doc.revokedBy?.name ? { name: doc.revokedBy.name, at: doc.revokedBy.at } : null,
    revokedReason: doc.revokedReason || "",
    lastVerification: doc.lastVerification
      ? {
        at: doc.lastVerification.at,
        outcome: doc.lastVerification.outcome,
        /* GRAV's own code, never a provider's. */
        reasonCode: doc.lastVerification.reasonCode || null,
        observedAccountName: doc.lastVerification.observedAccountName || null,
        observedCurrency: doc.lastVerification.observedCurrency || null,
        observedTimeZone: doc.lastVerification.observedTimeZone || null,
        observedIsManager: doc.lastVerification.observedIsManager,
        observedStatus: doc.lastVerification.observedStatus || null,
      }
      : null,
    revision: doc.revision,
  };
}

/** The live binding for a company and channel, or null. */
async function current({ companyId, channel }) {
  const code = assertChannel(channel);
  const doc = await Binding.findOne({
    companyId, channel: code, state: { $in: ["unverified", "verified", "unreachable"] },
  }).lean();
  return doc ? publicBinding(doc) : null;
}

module.exports = {
  bind,
  verify,
  revoke,
  forDeployment,
  current,
  /* Exported for the test that proves the refusal, not for ordinary callers. */
  assertBindable,
  normaliseAccountId,
  /* The Google-specific name three existing suites call. A thin alias. */
  normaliseGoogleAccountId,
  BINDABLE_CHANNELS,
  CHANNEL_ADAPTERS,
  CHANNEL_BINDING_FIELDS,
  callerFieldsFor,
};
