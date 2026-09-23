// services/marketing/campaignDrafts/draftIdentity.js
//
// THE OPAQUE, COMPANY-BOUND PUBLIC IDENTIFIER FOR A CAMPAIGN PLAN.
//
// ── WHY NOT THE MONGO _id, AND WHY NOT THE REFERENCE ───────────────────────
// A Mongo ObjectId leaks its creation time and is sequential enough that one id
// implies its neighbours exist. `MCP-2026-0001` is worse: it is guessable by
// design, so a caller with one company's reference can enumerate every plan in
// every company by incrementing it, and the route would have to rely entirely on
// its own company check to refuse them. That check is correct today and it is one
// line between a caller and another tenant's commercial plans.
//
// So the public identifier CARRIES the company and is signed. A caller holding
// company A's identifier cannot turn it into company B's, cannot turn plan 7 into
// plan 8, and cannot construct one at all.
//
// ── SIGNED, NOT ENCRYPTED ──────────────────────────────────────────────────
// The payload is decodable. That is fine and it is stated plainly here because
// the cursor in the advertising chunk got this wrong once: base64 was called
// opaque when it was merely an encoding. What an identifier must be is
// UNFORGEABLE. It is integrity-protected, and nothing may describe it as
// confidential.
//
// ── A THIRD SIGNING PURPOSE ────────────────────────────────────────────────
// `campaignIdentity.js` signs external provider campaign identifiers and
// `campaignCursor.js` signs page cursors, both from the same deployment secret
// under their own purpose strings. This derives a third. One shared key would
// mean a value minted for one contract verifies under another — a plan identifier
// accepted where an external campaign identifier was expected is how a read of a
// GRAV document becomes a read of an advertising account.
"use strict";

const crypto = require("crypto");

const { fail } = require("../../storePurchase/errors");
const secrets = require("../channels/channelSecrets");

const str = (v) => String(v ?? "").trim();

const VERSION = "d1";
const PURPOSE = "grav.marketing.campaign.draft.v1";
const SIG_BYTES = 16;

function keyFor(env) {
  const secret = secrets.campaignIdSecret(env);
  if (!secret) {
    throw fail("CHANNEL_IDENTITY_NOT_CONFIGURED",
      "Campaign plan identifiers cannot be issued in this deployment.",
      { missing: [secrets.CAMPAIGN_ID_SECRET_VAR] });
  }
  return crypto.createHmac("sha256", secret).update(PURPOSE).digest();
}

const sign = (key, payload) =>
  crypto.createHmac("sha256", key).update(payload).digest().subarray(0, SIG_BYTES).toString("base64url");

/**
 * Mint the public identifier for one plan.
 *
 * @param {object} args
 * @param {string} args.companyId the resolved company, from membership
 * @param {string} args.draftId   the document's own `_id`, as a string
 */
function encodeDraftId({ companyId, draftId }, env = process.env) {
  const company = str(companyId);
  const id = str(draftId);

  if (!company || !id) {
    throw fail("VALIDATION", "A campaign plan identifier needs a company and a plan.");
  }
  /* Both are hex ObjectIds. Checked rather than trusted, so a value containing
     the delimiter cannot make one field bleed into the next — the same class of
     bug the page cursor solves with a length prefix, solved here by refusing
     anything that is not 24 hex characters. */
  if (!/^[0-9a-f]{24}$/i.test(company) || !/^[0-9a-f]{24}$/i.test(id)) {
    throw fail("VALIDATION", "That is not a campaign plan GRAV can identify.");
  }

  const payload = `${VERSION}.${company}.${id}`;
  return `${Buffer.from(payload, "utf8").toString("base64url")}.${sign(keyFor(env), payload)}`;
}

/**
 * Resolve a public identifier to an internal plan id, or refuse.
 *
 * ── ONE REFUSAL FOR EVERY CAUSE ────────────────────────────────────────────
 * Malformed, badly signed and signed-for-another-company all produce the same
 * 404 with the same sentence. Distinguishing them would confirm to somebody
 * probing identifiers which part they got wrong, and "this company exists" is
 * exactly what an opaque identifier is here to withhold.
 *
 * The company compared against is the CALLER'S resolved company, established
 * from membership — never one from a query string or a body.
 */
function decodeDraftId(raw, { companyId } = {}, env = process.env) {
  const refuse = () => fail("CAMPAIGN_DRAFT_NOT_FOUND", "That campaign plan is not one GRAV can show you.");

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

  /* Verified before parsed, so the parser below only ever sees bytes GRAV
     produced. */
  const expected = Buffer.from(sign(keyFor(env), payload), "utf8");
  const supplied = Buffer.from(signature, "utf8");
  if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) {
    throw refuse();
  }

  const parts = payload.split(".");
  if (parts.length !== 3) throw refuse();
  const [version, tokenCompany, draftId] = parts;
  if (version !== VERSION) throw refuse();
  if (!/^[0-9a-f]{24}$/i.test(draftId)) throw refuse();

  /* GRAV's own signature, for a different company. Not forgery — an identifier
     that leaked or was pasted across a tenancy boundary — and refused exactly as
     loudly, because the consequence is identical. */
  if (tokenCompany !== company) throw refuse();

  return { companyId: tokenCompany, draftId };
}

module.exports = { encodeDraftId, decodeDraftId, VERSION, PURPOSE };
