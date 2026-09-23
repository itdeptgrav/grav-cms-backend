// services/marketing/channels/campaignCursor.js
//
// THE INTEGRITY-PROTECTED PAGE CURSOR.
//
// ── BASE64 IS AN ENCODING, NOT A BOUNDARY ──────────────────────────────────
// The first version of this wrapped the channel and the provider's page token in
// base64 and called it opaque. Base64 is reversible by anybody with a browser
// console, and — the part that actually mattered — it is EDITABLE. A caller
// could decode `google_ads <token>`, rewrite the channel, re-encode, and hand
// GRAV a cursor that paged one provider's list with another's token. What that
// produced would depend on the provider, and none of the possibilities were ones
// GRAV had reasoned about.
//
// So the cursor is signed. Not encrypted — signed. The distinction is worth
// stating plainly because the previous comment got it wrong:
//
//   The payload is STILL DECODABLE. Anybody can read the company id, the channel
//   and the provider's token out of one. That is fine. What a cursor must be is
//   UNFORGEABLE, so that editing any field produces a value that fails
//   verification rather than one that pages somewhere unintended.
//
// This is integrity protection. It is not confidentiality, and nothing in this
// file or its callers may describe it as such.
//
// ── A SEPARATE SIGNING PURPOSE ─────────────────────────────────────────────
// `campaignIdentity.js` signs campaign identifiers with a key derived from the
// same deployment secret. This derives a DIFFERENT key from that secret, under
// its own purpose string, so a cursor can never verify as a campaign identifier
// or the reverse. Sharing one derived key would mean a bug in either verifier
// became a bug in both, and would let a value minted for one contract be
// presented to the other.
//
// ── AND EVERY REFUSAL IS LOCAL ─────────────────────────────────────────────
// Verification is one HMAC. A modified, foreign, cross-channel or malformed
// cursor is refused before any provider is contacted.
"use strict";

const crypto = require("crypto");

const { fail } = require("../../storePurchase/errors");
const secrets = require("./channelSecrets");
const { MARKETING_CHANNEL_CODES } = require("../../../constants/marketingChannels");

const str = (v) => String(v ?? "").trim();

/* Bumped if the payload shape changes, so an old cursor fails verification
   rather than being parsed under new rules. */
const VERSION = "k1";

/* Distinct from the campaign identifier's purpose string. This one line is what
   keeps the two contracts' keys apart. */
const PURPOSE = "grav.marketing.campaign.cursor.v1";

const SIG_BYTES = 16;

function keyFor(env) {
  const secret = secrets.campaignIdSecret(env);
  if (!secret) {
    throw fail("CHANNEL_IDENTITY_NOT_CONFIGURED",
      "Campaign pages cannot be issued in this deployment.",
      { missing: [secrets.CAMPAIGN_ID_SECRET_VAR] });
  }
  return crypto.createHmac("sha256", secret).update(PURPOSE).digest();
}

const sign = (key, payload) =>
  crypto.createHmac("sha256", key).update(payload).digest().subarray(0, SIG_BYTES).toString("base64url");

/**
 * Mint a cursor for the next page.
 *
 * @param {object} args
 * @param {string} args.companyId   the RESOLVED company, from membership
 * @param {string} args.channel
 * @param {string} args.pageToken   the provider's own token, unaltered
 */
function encodeCursor({ companyId, channel, pageToken }, env = process.env) {
  const company = str(companyId);
  const chan = str(channel);
  const token = str(pageToken);

  if (!company || !chan || !token) {
    throw fail("VALIDATION", "A page cursor needs a company, a channel and a page token.");
  }
  if (!MARKETING_CHANNEL_CODES.includes(chan)) {
    throw fail("VALIDATION", "That is not a channel GRAV connects to.", { channel: chan });
  }

  /* ── THE PROVIDER TOKEN IS LENGTH-DELIMITED, NOT DELIMITER-SEPARATED ─────
     Google's page tokens and Meta's `after` cursors are opaque provider strings
     that may contain any character, including whatever delimiter this format
     picked. A split-on-delimiter parse would then let a crafted token bleed into
     the next field. The token's byte length is written first, so parsing is
     positional and no character in it can be structural. */
  const payload = `${VERSION}.${company}.${chan}.${Buffer.byteLength(token, "utf8")}.${token}`;
  return `${Buffer.from(payload, "utf8").toString("base64url")}.${sign(keyFor(env), payload)}`;
}

/**
 * Resolve a cursor, or refuse.
 *
 * ── ONE REFUSAL FOR EVERY CAUSE ────────────────────────────────────────────
 * Modified, foreign, cross-channel and malformed all produce the same message.
 * Distinguishing them would tell somebody probing cursors which field they got
 * wrong, which is a decoding oracle for the very fields the signature protects.
 *
 * @returns {string|null} the provider's page token, or null when no cursor was
 *   supplied — the first page is not an error.
 */
function decodeCursor(raw, { companyId, channel } = {}, env = process.env) {
  const refuse = () => fail("VALIDATION", "That is not a valid page cursor.", { field: "cursor" });

  const value = str(raw);
  if (!value) return null;

  const company = str(companyId);
  const chan = str(channel);
  if (!company || !chan) throw refuse();

  const dot = value.lastIndexOf(".");
  if (dot <= 0) throw refuse();

  const body = value.slice(0, dot);
  const signature = value.slice(dot + 1);

  let payload = "";
  try {
    payload = Buffer.from(body, "base64url").toString("utf8");
  } catch {
    throw refuse();
  }

  /* ── VERIFY BEFORE PARSING ────────────────────────────────────────────────
     The signature covers the whole payload, so checking it first means the
     parser below only ever sees bytes GRAV itself produced. Parsing first and
     verifying afterwards would run a hand-written parser on attacker-controlled
     input for no reason. */
  const expected = Buffer.from(sign(keyFor(env), payload), "utf8");
  const supplied = Buffer.from(signature, "utf8");
  if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) {
    throw refuse();
  }

  /* Positional parse: version, company, channel, token length, then exactly that
     many bytes of token. */
  const parts = payload.split(".");
  if (parts.length < 5) throw refuse();
  const [version, tokenCompany, tokenChannel, lengthText] = parts;
  if (version !== VERSION) throw refuse();

  const declaredLength = Number(lengthText);
  if (!Number.isSafeInteger(declaredLength) || declaredLength <= 0) throw refuse();

  const prefix = `${version}.${tokenCompany}.${tokenChannel}.${lengthText}.`;
  const token = payload.slice(prefix.length);
  if (Buffer.byteLength(token, "utf8") !== declaredLength) throw refuse();

  /* Signed by GRAV, for a different company. Not forgery — a cursor that leaked
     or was pasted across a tenancy boundary — and refused exactly as loudly. */
  if (tokenCompany !== company) throw refuse();
  /* Signed by GRAV, for a different channel's list. Paging Meta with a Google
     token is not something GRAV has reasoned about, so it does not happen. */
  if (tokenChannel !== chan) throw refuse();

  return token;
}

module.exports = { encodeCursor, decodeCursor, VERSION, PURPOSE };
