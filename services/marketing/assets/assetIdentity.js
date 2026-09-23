// services/marketing/assets/assetIdentity.js
//
// THE OPAQUE PUBLIC IDENTIFIER FOR ONE ADVERTISING IMAGE VERSION.
//
// ── WHY NEITHER THE DATABASE ID NOR THE DRIVE ID IS THE IDENTITY ───────────
// A Mongo ObjectId is sequential enough to enumerate and it is a key into
// GRAV's own collection. A Drive file id is a key into a shared company Drive
// that holds payroll letters and vouchers — publishing one would hand a caller
// a name for a file GRAV never inspected, and let them ask GRAV to use it.
//
// So the public identifier is a signed token carrying the company and the
// version's internal id. It is not confidential — anybody with a base64 decoder
// can read it, which is fine — but it is UNFORGEABLE, so editing the company
// out of one produces a token that fails verification rather than one that
// reads another tenant's image.
//
// The same shape, the same secret and the same separation of purposes as the
// campaign-plan identifier beside it.
"use strict";

const crypto = require("crypto");

const { fail } = require("../../storePurchase/errors");
const secrets = require("../channels/channelSecrets");

const VERSION = "mai1";
const PURPOSE = "grav.marketing.advertising.asset.v1";
const SIG_BYTES = 16;

const str = (v) => String(v ?? "").trim();

const keyFor = (env) => crypto
  .createHmac("sha256", secrets.campaignIdSecret(env))
  .update(PURPOSE)
  .digest();

const sign = (payload, key) => crypto
  .createHmac("sha256", key).update(payload).digest().subarray(0, SIG_BYTES).toString("base64url");

/** `mai1.<base64url payload>.<signature>` */
function encodeAssetId({ companyId, assetId }, env = process.env) {
  const company = str(companyId);
  const asset = str(assetId);
  if (!company || !asset) {
    throw fail("VALIDATION", "GRAV cannot build an identifier for that image.", { field: "assetId" });
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
function decodeAssetId(token, { companyId }, env = process.env) {
  const raw = str(token);
  const parts = raw.split(".");
  if (parts.length !== 3 || parts[0] !== VERSION) {
    throw fail("NOT_FOUND", "That advertising image could not be found.", { field: "assetId" });
  }

  const expected = sign(`${parts[0]}.${parts[1]}`, keyFor(env));
  /* Constant-time, so the comparison cannot be used to discover a valid
     signature one byte at a time. */
  const a = Buffer.from(parts[2]);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw fail("NOT_FOUND", "That advertising image could not be found.", { field: "assetId" });
  }

  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    throw fail("NOT_FOUND", "That advertising image could not be found.", { field: "assetId" });
  }

  if (str(decoded?.c) !== str(companyId)) {
    /* Deliberately the same message and the same status as a token that does
       not exist. Distinguishing them would confirm that an image exists in
       somebody else's company. */
    throw fail("NOT_FOUND", "That advertising image could not be found.", { field: "assetId" });
  }

  return { assetId: str(decoded.a) };
}

module.exports = { encodeAssetId, decodeAssetId, VERSION };
