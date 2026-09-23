// services/marketing/channels/campaignIdentity.js
//
// THE OPAQUE PUBLIC CAMPAIGN IDENTIFIER.
//
// ── WHY A PROVIDER ID IS NOT THE PUBLIC IDENTITY ───────────────────────────
// A Google Ads campaign id and a Meta campaign id are both bare integers. Used
// directly as GRAV's public identity they would give a caller three things they
// must not have:
//
//   1. A guessable neighbour. Campaign 20481 implies campaign 20482 exists, and
//      a route that resolves the id it is handed would then read another
//      company's campaign out of a shared advertising account.
//   2. A channel to choose. `/campaigns/20481/performance` has to be told which
//      provider to ask, and any caller-supplied answer is a caller deciding
//      which upstream GRAV calls.
//   3. Free reconnaissance. The id is stable, so it identifies the account
//      across sessions and companies.
//
// ── SIGNED, NOT STORED ─────────────────────────────────────────────────────
// The token CARRIES company, channel and provider id, and an HMAC over all
// three. No collection, no lookup, nothing to grow or to migrate — and,
// importantly, no window where a token minted by one request is not yet
// readable by another.
//
// The signature is what makes it safe: the payload is readable by anybody with
// a base64 decoder, and that is fine. It is not confidential. What it must be
// is UNFORGEABLE, so that editing the company id out of one produces a token
// that fails verification instead of a token that reads another tenant's data.
//
// ── AND A BAD ID COSTS NOTHING ─────────────────────────────────────────────
// Verification is local arithmetic. A malformed, forged, expired or foreign
// token is refused before any provider is contacted, which is the requirement
// and also the reason this cannot be used to make GRAV hammer an upstream API.
"use strict";

const crypto = require("crypto");

const { fail } = require("../../storePurchase/errors");
const secrets = require("./channelSecrets");
const { MARKETING_CHANNEL_CODES } = require("../../../constants/marketingChannels");

const str = (v) => String(v ?? "").trim();

/* Bumped if the payload shape ever changes. An old token then fails
   verification rather than being parsed under new rules. */
const VERSION = "c1";

/* Truncated to 128 bits. Full SHA-256 would double the token length for no
   meaningful gain against forgery of a value that lives for one page view. */
const SIG_BYTES = 16;

function keyFor(env) {
  const secret = secrets.campaignIdSecret(env);
  if (!secret) {
    throw fail("CHANNEL_IDENTITY_NOT_CONFIGURED",
      "Campaign identifiers cannot be issued in this deployment.",
      { missing: [secrets.CAMPAIGN_ID_SECRET_VAR] });
  }
  /* Derived rather than used raw, so this key cannot be replayed against
     anything else that happens to be signed with the same variable later. */
  return crypto.createHmac("sha256", secret).update("grav.marketing.campaign.v1").digest();
}

const sign = (key, payload) =>
  crypto.createHmac("sha256", key).update(payload).digest().subarray(0, SIG_BYTES).toString("base64url");

/**
 * Mint the public identifier for one provider campaign.
 *
 * @param {object}  args
 * @param {string}  args.companyId          the GRAV company, as a string
 * @param {string}  args.channel            a marketing channel code
 * @param {string}  args.providerCampaignId the provider's own id, unaltered
 */
function encodeCampaignId({ companyId, channel, providerCampaignId }, env = process.env) {
  const company = str(companyId);
  const chan = str(channel);
  const provider = str(providerCampaignId);

  if (!company || !chan || !provider) {
    throw fail("VALIDATION", "A campaign identifier needs a company, a channel and a provider id.");
  }
  if (!MARKETING_CHANNEL_CODES.includes(chan)) {
    throw fail("VALIDATION", "That is not a channel GRAV connects to.", { channel: chan });
  }
  /* The provider id goes into a delimited payload, so a value containing the
     delimiter would let one field bleed into the next. Both providers issue
     bare integers; anything else is refused rather than escaped, because an
     escaping scheme is a second thing to get right. */
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(provider)) {
    throw fail("VALIDATION", "That campaign identifier is not one GRAV can carry.", { field: "providerCampaignId" });
  }

  const payload = `${VERSION}.${company}.${chan}.${provider}`;
  return `${Buffer.from(payload, "utf8").toString("base64url")}.${sign(keyFor(env), payload)}`;
}

/**
 * Resolve a public identifier, or refuse.
 *
 * ── EVERY REFUSAL IS THE SAME REFUSAL ──────────────────────────────────────
 * Malformed, badly signed, and signed-for-another-company all produce one
 * message and one code. Distinguishing them would confirm to a caller probing
 * ids that a given company/channel pair exists, which is exactly the
 * enumeration this identifier is here to prevent.
 *
 * The company is compared with the CALLER'S resolved company — the one
 * `resolveCompanyForActor` established from membership, never one from a query
 * string — so a valid token from company A presented by company B is refused.
 */
function decodeCampaignId(raw, { companyId } = {}, env = process.env) {
  const refuse = () => fail("CAMPAIGN_NOT_FOUND", "That campaign is not one GRAV can show you.");

  const token = str(raw);
  const company = str(companyId);
  if (!token || !company) throw refuse();

  const dot = token.lastIndexOf(".");
  if (dot <= 0) throw refuse();

  const body = token.slice(0, dot);
  const signature = token.slice(dot + 1);

  let payload = "";
  try {
    payload = Buffer.from(body, "base64url").toString("utf8");
  } catch {
    throw refuse();
  }

  const parts = payload.split(".");
  if (parts.length !== 4) throw refuse();
  const [version, tokenCompany, channel, providerCampaignId] = parts;
  if (version !== VERSION) throw refuse();

  /* Constant-time, and length-checked first because `timingSafeEqual` throws on
     a length mismatch rather than returning false. */
  const expected = Buffer.from(sign(keyFor(env), payload), "utf8");
  const supplied = Buffer.from(signature, "utf8");
  if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) {
    throw refuse();
  }

  /* Signed for a different company. The signature was GRAV's own, so this is
     not forgery — it is a token that leaked, or was pasted, across a tenancy
     boundary, and it is refused exactly as loudly. */
  if (tokenCompany !== company) throw refuse();
  if (!MARKETING_CHANNEL_CODES.includes(channel)) throw refuse();

  return { companyId: tokenCompany, channel, providerCampaignId };
}

module.exports = { encodeCampaignId, decodeCampaignId, VERSION };
