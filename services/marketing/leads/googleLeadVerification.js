// services/marketing/leads/googleLeadVerification.js
//
// IS THIS DELIVERY ACTUALLY FROM GOOGLE?
//
// ── WHAT GOOGLE GIVES US, AND WHAT IT DOES NOT ─────────────────────────────
// `google_key` is, in Google's own words, "a key configured by the advertiser
// with each form", sent "as part of the webhook payload". It is a shared secret
// inside the JSON body.
//
// There is no signature. No HMAC, no signing key, no signature header, nothing
// over the body at all. That is weaker than a signed webhook in a specific way
// worth naming: a signature proves the body was not altered and cannot be
// replayed by somebody who merely saw one, and a shared secret proves neither.
// Anybody who has ever seen a delivery holds a token that opens the door again.
//
// Two consequences shape everything downstream:
//
//   Verification alone is not sufficient. Deduplication on `lead_id` is part of
//   the security contract, not an efficiency — it is what stops a replayed body
//   becoming a second person, a second engagement and a second prospect.
//
//   GRAV must not invent the missing signature. A verifier that looked for an
//   `X-Goog-Signature` header would refuse every genuine lead, because Google
//   does not send one. The temptation is real: the code would look more secure
//   and would work perfectly in a test written against the same assumption.
//
// ── AND THE SECRET LEAVES NO TRACE ─────────────────────────────────────────
// It is compared and dropped. It is never logged, never returned, never stored
// beside the lead, and never included in an error — a refusal that echoed the
// key it rejected would put a working credential into the log of whoever sent
// the wrong one.
"use strict";

const crypto = require("crypto");

const W = require("../../../constants/marketingGoogleLeadWebhook");

const str = (v) => String(v ?? "").trim();

/**
 * Compare two secrets without revealing, through timing, how much matched.
 *
 * ── WHY NOT `===` ──────────────────────────────────────────────────────────
 * String comparison stops at the first differing character, so the time it
 * takes is proportional to the length of the matching prefix. An attacker who
 * can send many deliveries and measure the response learns the secret one
 * character at a time. It is a slow attack and an entirely practical one
 * against an endpoint that is, by design, reachable from the internet.
 *
 * `timingSafeEqual` needs equal lengths, and throws otherwise — which would
 * itself leak the length. So both sides are hashed first: a digest is always
 * 32 bytes, so the comparison is over a constant length whatever was sent, and
 * an empty or enormous candidate costs exactly what a correct one costs.
 */
function secretsMatch(candidate, expected) {
  const a = crypto.createHash("sha256").update(String(candidate ?? ""), "utf8").digest();
  const b = crypto.createHash("sha256").update(String(expected ?? ""), "utf8").digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * Read the secret out of a delivery.
 *
 * Both documented spellings are accepted. The proto says `google_key`, and
 * Google's own published TEST samples say `Google_key` — refusing the second
 * would refuse the official sample, so anybody following the documented testing
 * procedure would watch verification fail and conclude GRAV was broken.
 *
 * This accepts a second spelling of the same field. It does not accept a second
 * secret, a weaker check or a missing one.
 */
function suppliedSecret(payload) {
  const p = payload && typeof payload === "object" ? payload : {};
  for (const field of W.KEY_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(p, field)) {
      const value = str(p[field]);
      if (value) return value;
    }
  }
  return "";
}

/**
 * Verify a delivery.
 *
 * @param {object} args
 * @param {object} args.payload   the parsed delivery
 * @param {string} args.expected  the secret configured for this form
 * @returns {{verified: boolean, reason?: string}}
 */
function verify({ payload, expected } = {}) {
  const configured = str(expected);

  /* ── NO CONFIGURED SECRET IS A REFUSAL, NEVER A PASS ─────────────────────
     If this ever compared "" against "" it would accept every delivery from
     anybody. Checked before anything else, and answered as a server fault
     rather than a bad request — the sender did nothing wrong, GRAV is not
     configured, and telling Google to retry is the right answer because
     somebody may be about to configure it. */
  if (!configured) {
    return { verified: false, reason: "not_configured", retryable: true };
  }

  const supplied = suppliedSecret(payload);

  /* Still compared even when absent, so a delivery with no key costs the same
     as one with a wrong key and reveals nothing by returning faster. */
  if (!secretsMatch(supplied, configured)) {
    /* ── THE MESSAGE NAMES NOTHING ────────────────────────────────────────
        Not the expected secret, not the supplied one, not its length, not
        which spelling was used, not whether the field was present at all. */
    return { verified: false, reason: supplied ? "secret_mismatch" : "secret_missing", retryable: false };
  }

  return { verified: true };
}

/**
 * The HTTP answer for an outcome, from Google's own Lead handling table.
 *
 * The retry semantics are the whole point. A 4XX tells Google never to try
 * again; a 5XX tells it to try later. So a wrong secret is 4XX — it will not
 * become right on a retry — and a GRAV fault is 5XX, or a genuine lead is lost
 * because a database was briefly busy.
 *
 * A DUPLICATE answers 200. GRAV already has that lead, and any other answer
 * asks Google to keep redelivering something that arrived safely.
 */
function httpOutcome(outcome, message = "") {
  const spec = W.RESPONSES[outcome] || W.RESPONSES.TRY_AGAIN;
  return {
    status: spec.status,
    /* Google's documented success body is `{}` — not `{success: true}`. */
    body: spec.status === 200 ? {} : { message: str(message) || "Refused." },
    retryable: spec.retryable,
  };
}

module.exports = {
  verify,
  secretsMatch,
  suppliedSecret,
  httpOutcome,
};
