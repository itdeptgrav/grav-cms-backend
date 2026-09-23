// services/marketing/leads/deliveryToken.js
//
// THE PUBLIC ADDRESS GOOGLE POSTS A LEAD TO.
//
// ── THIS ONE RESOLVES A COMPANY RATHER THAN CHECKING ONE ───────────────────
// Every other signed identifier in Marketing is verified AGAINST a company the
// caller already proved — a marketer is authenticated, their company is known,
// and the token only has to agree.
//
// Google is not authenticated and has no idea what a GRAV company is. It posts
// to a URL. So this token has to answer the question "whose lead is this?" all
// by itself, which makes its signature the whole of the trust: an unsigned or
// guessable token would let anybody direct a forged lead into any tenant they
// could name.
//
// It is deliberately NOT the security boundary on its own. A valid token
// identifies a binding; the derived webhook key proves the delivery is
// Google's. The token says which door, the key says who is knocking.
//
// ── AND IT NAMES NOTHING ───────────────────────────────────────────────────
// The payload carries a company id and a binding id, base64url-encoded, which
// is encoding rather than encryption — anybody can read it. That is acceptable
// for an identifier and unacceptable for a secret, which is exactly why the
// secret is not in here and is derived instead.
//
// What it must never carry is a provider identifier: a URL sitting in Google's
// form configuration, visible to anybody who can open that account, should not
// also disclose somebody's advertising campaign number.
"use strict";

const crypto = require("crypto");

const { fail } = require("../../storePurchase/errors");
const secrets = require("../channels/channelSecrets");

const VERSION = "gld1";

/* ── ITS OWN PURPOSE, SEPARATE FROM EVERY OTHER TOKEN ───────────────────────
   The same repository pattern and the same underlying secret as the campaign
   plan, advertising asset and analysis identifiers — with a different purpose
   string, so the derived signing keys are unrelated.

   One key used for several things means a weakness in any of them is a
   weakness in all. That matters more here than anywhere else in Marketing,
   because this is the only token an unauthenticated stranger is invited to
   present. */
const PURPOSE = "grav.marketing.google-lead-delivery.v1";

/* Longer than the 16 bytes used elsewhere. Those tokens are presented by an
   authenticated caller whose company is already known; this one is the sole
   thing standing between the open internet and naming a tenant, so forging it
   should be correspondingly harder. */
const SIG_BYTES = 24;

const str = (v) => String(v ?? "").trim();

const keyFor = (env) => crypto
  .createHmac("sha256", secrets.campaignIdSecret(env))
  .update(PURPOSE)
  .digest();

const sign = (payload, key) => crypto
  .createHmac("sha256", key).update(payload).digest().subarray(0, SIG_BYTES).toString("base64url");

/**
 * The public token for one delivery binding.
 *
 * `gld1.<base64url payload>.<signature>` — URL-safe, because it lives in a path
 * segment that Google stores in a form's configuration.
 */
function encodeDeliveryToken({ companyId, bindingId }, env = process.env) {
  const company = str(companyId);
  const binding = str(bindingId);
  if (!company || !binding) {
    throw fail("VALIDATION", "A delivery address needs a company and a binding.",
      { field: "deliveryToken" });
  }

  const payload = Buffer.from(JSON.stringify({ c: company, b: binding }), "utf8").toString("base64url");
  return `${VERSION}.${payload}.${sign(`${VERSION}.${payload}`, keyFor(env))}`;
}

/**
 * Whose binding this token names, or a refusal.
 *
 * ── NO COMPANY IS SUPPLIED, AND NONE IS ACCEPTED ───────────────────────────
 * The caller cannot pass one in to be checked against, because the caller here
 * is Google and has nothing to pass. The company comes OUT of the token, and
 * the only reason that is safe is the signature — an attacker who edits the
 * company into one they fancy produces a token that fails verification.
 *
 * Every refusal is the same refusal. A token for a company that does not exist,
 * a token whose signature is wrong and a token that is simply gibberish all
 * produce one message, because telling them apart would let somebody map which
 * bindings exist by watching the differences.
 */
function decodeDeliveryToken(token, env = process.env) {
  const raw = str(token);
  const refuse = () => fail("NOT_FOUND", "That delivery address is not one GRAV recognises.",
    { field: "deliveryToken" });

  const parts = raw.split(".");
  if (parts.length !== 3 || parts[0] !== VERSION) throw refuse();

  const expected = sign(`${parts[0]}.${parts[1]}`, keyFor(env));

  /* Constant-time, so the comparison cannot be used to discover a valid
     signature one character at a time — and this endpoint is, by design,
     something a stranger may call as often as they like. */
  const a = Buffer.from(parts[2]);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw refuse();

  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    throw refuse();
  }

  const companyId = str(decoded?.c);
  const bindingId = str(decoded?.b);
  if (!companyId || !bindingId) throw refuse();

  return { companyId, bindingId };
}

module.exports = { encodeDeliveryToken, decodeDeliveryToken, VERSION, PURPOSE };
