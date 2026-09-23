// services/marketing/intelligence/analysisIdentity.js
//
// THE OPAQUE PUBLIC IDENTIFIER FOR ONE CAMPAIGN ANALYSIS.
//
// ── WHY THE DATABASE ID IS NOT THE IDENTITY ────────────────────────────────
// A Mongo ObjectId is sequential enough to enumerate and it is a key into
// GRAV's own collection. Publishing one on an analysis would let a caller name
// a row — and an analysis is the one record somebody might want to tamper with,
// because it is the one carrying advice.
//
// So the public identifier is a signed token carrying the company and the
// analysis's internal id. It is not confidential — anybody with a base64
// decoder can read it, which is fine — but it is UNFORGEABLE, so editing the
// company out of one produces a token that fails verification rather than one
// that reads another tenant's advice.
//
// The same shape, the same secret and a SEPARATE signing purpose from the
// advertising-asset identifier beside it: one key used for two things means a
// weakness in either is a weakness in both.
"use strict";

const crypto = require("crypto");

const { fail } = require("../../storePurchase/errors");
const secrets = require("../channels/channelSecrets");

const VERSION = "mca1";
const PURPOSE = "grav.marketing.campaign.analysis.v1";
const SIG_BYTES = 16;

const str = (v) => String(v ?? "").trim();

const keyFor = (env) => crypto
  .createHmac("sha256", secrets.campaignIdSecret(env))
  .update(PURPOSE)
  .digest();

const sign = (payload, key) => crypto
  .createHmac("sha256", key).update(payload).digest().subarray(0, SIG_BYTES).toString("base64url");

/** `mai1.<base64url payload>.<signature>` */
function encodeAnalysisId({ companyId, analysisId }, env = process.env) {
  const company = str(companyId);
  const asset = str(analysisId);
  if (!company || !asset) {
    throw fail("VALIDATION", "GRAV cannot build an identifier for that image.", { field: "analysisId" });
  }
  const payload = Buffer.from(JSON.stringify({ c: company, a: asset }), "utf8").toString("base64url");
  return `${VERSION}.${payload}.${sign(`${VERSION}.${payload}`, keyFor(env))}`;
}

/**
 * The internal id this token names, or a refusal.
 *
 * ── THE COMPANY IS CHECKED HERE AND AGAIN IN THE SELECTOR ──────────────────
 * Two independent checks. This one catches a forged or foreign token before any
 * query runs; the selector catches anything that got past it. A single check is
 * one line between a caller and another tenant's images.
 */
function decodeAnalysisId(token, { companyId }, env = process.env) {
  const raw = str(token);
  const parts = raw.split(".");
  if (parts.length !== 3 || parts[0] !== VERSION) {
    throw fail("NOT_FOUND", "That analysis could not be found.", { field: "analysisId" });
  }

  const expected = sign(`${parts[0]}.${parts[1]}`, keyFor(env));
  /* Constant-time, so the comparison cannot be used to discover a valid
     signature one byte at a time. */
  const a = Buffer.from(parts[2]);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw fail("NOT_FOUND", "That analysis could not be found.", { field: "analysisId" });
  }

  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    throw fail("NOT_FOUND", "That analysis could not be found.", { field: "analysisId" });
  }

  if (str(decoded?.c) !== str(companyId)) {
    /* Deliberately the same message and the same status as a token that does
       not exist. Distinguishing them would confirm that an image exists in
       somebody else's company. */
    throw fail("NOT_FOUND", "That analysis could not be found.", { field: "analysisId" });
  }

  return { analysisId: str(decoded.a) };
}

module.exports = { encodeAnalysisId, decodeAnalysisId, VERSION };
