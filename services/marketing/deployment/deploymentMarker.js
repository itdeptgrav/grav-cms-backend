// services/marketing/deployment/deploymentMarker.js
//
// THE MARK GRAV PUTS ON A CAMPAIGN SO IT CAN FIND IT AGAIN.
//
// ── THE PROBLEM A MARKER SOLVES ────────────────────────────────────────────
// A create request times out. Something may exist in the advertising account
// and GRAV has no idea what. To recover, it has to be able to walk into that
// account and ask: did MY request, the one identified by this exact deployment
// command, actually take effect?
//
// A campaign NAME cannot answer that. Names are not unique in Google Ads; two
// GRAV plans can legitimately produce the same name; a removed campaign keeps
// its name for ever; and anybody with account access can create, rename or copy
// a campaign into that name by hand. A name match is a coincidence that looks
// like proof, and acting on it either abandons a real campaign or creates a
// second one.
//
// A label is different. GRAV chooses the string, it is unique within the
// account by Google's own constraint, and it is attached to the campaign inside
// the same atomic request that creates it — so a campaign carrying this label
// exists if and only if that one request succeeded.
//
// ── WHAT IT IS DERIVED FROM, AND WHAT IT MUST NOT CONTAIN ──────────────────
// It is an HMAC over the deployment command's IMMUTABLE identity: the company,
// the binding, the account, the plan, the approved revision and the command
// key. So:
//
//   the same command retried produces the same marker — which is what makes a
//   lost response recoverable rather than a permanent unknown;
//
//   a different company, account, binding, plan, revision or command produces a
//   different one — so one company's reconciliation can never match another's
//   campaign, and a re-approved plan is not confused with its earlier revision.
//
// What comes OUT is a hex digest. It carries no credential, no database id, no
// person's name, no plan name and no business text: an advertising account is
// visible to agencies, contractors and anybody the client has added, and a
// label is visible to all of them. A marker that spelled out "GRAV-acme-q4-
// redundancy-campaign" would publish GRAV's internal planning to every one of
// them, and a marker carrying a Mongo id would hand them a key into GRAV.
"use strict";

const crypto = require("crypto");

const { fail } = require("../../storePurchase/errors");
const secrets = require("../channels/channelSecrets");
const { stableJson } = require("../campaignDrafts/campaignAllocation.service");

const str = (v) => String(v ?? "").trim();

/* ── THE SHAPE, AND WHY IT IS THIS SHAPE ────────────────────────────────────
   Google allows 80 characters in a label name. This uses 43, which leaves room
   and stays short enough to read in a list.

   The `GRAV-D1` prefix is a version, not decoration: the day the derivation
   changes, an old marker must not be mistaken for a new one, and a reconciler
   reading an account can see which scheme a campaign was marked under. `D` is
   for deployment — a later chunk marking something else gets its own letter
   rather than colliding in the same namespace. */
const PREFIX = "GRAV-D1-";
const DIGEST_CHARS = 32;
const MARKER_PATTERN = /^GRAV-D1-[0-9a-f]{32}$/;

/* Google's own limit on a label name. Asserted rather than assumed, because a
   marker one character too long is refused by the provider halfway through the
   only request that was going to create anything. */
const LABEL_NAME_MAX = 80;

/* ── A SEPARATE SIGNING PURPOSE ─────────────────────────────────────────────
   The campaign-identity token and the pagination cursor derive their own keys
   from the same deployment secret under their own purposes. This does too. One
   key used for three things means a weakness in any one of them is a weakness
   in all three, and rotating for one reason breaks the other two. */
const PURPOSE = "grav.marketing.deployment.marker.v1";

const keyFor = (env) => crypto
  .createHmac("sha256", secrets.campaignIdSecret(env))
  .update(PURPOSE)
  .digest();

/**
 * The marker for one deployment command.
 *
 * ── EVERY FIELD HERE IS IMMUTABLE FOR THE LIFE OF THE COMMAND ──────────────
 * Nothing derived from the plan's editable content is in it — not the campaign
 * name, not the budget, not the targeting. Those can change between one attempt
 * and its retry (they should not, and the fence refuses it, but the marker must
 * not be the thing that breaks if they do). What identifies the command is who
 * asked, for which plan revision, into which account, under which key.
 *
 * @param {object} identity
 * @param {string} identity.companyId
 * @param {string} identity.bindingId          which binding decision
 * @param {string} identity.externalAccountId  which advertising account
 * @param {string} identity.campaignDraftId
 * @param {number} identity.approvedRevision
 * @param {string} identity.commandKey         the caller's request identity
 * @param {string} identity.channel
 * @param {string} identity.campaignType
 */
function markerFor(identity, env = process.env) {
  const basis = {
    v: 1,
    companyId: str(identity?.companyId),
    bindingId: str(identity?.bindingId),
    externalAccountId: str(identity?.externalAccountId),
    campaignDraftId: str(identity?.campaignDraftId),
    approvedRevision: Number(identity?.approvedRevision) || 0,
    commandKey: str(identity?.commandKey),
    channel: str(identity?.channel),
    campaignType: str(identity?.campaignType),
  };

  /* ── AN INCOMPLETE IDENTITY IS NOT A MARKER ─────────────────────────────
     A marker derived from a missing company would be stable, look valid, and
     match the marker of every other deployment with a missing company. That is
     the one failure a marker must not have: two different commands sharing
     one. */
  for (const [field, value] of Object.entries(basis)) {
    if (field === "v") continue;
    if (value === "" || value === 0) {
      throw fail("VALIDATION",
        "A deployment marker needs the full identity of the command it marks.",
        { field });
    }
  }

  const digest = crypto
    .createHmac("sha256", keyFor(env))
    .update(stableJson(basis))
    .digest("hex")
    .slice(0, DIGEST_CHARS);

  const marker = `${PREFIX}${digest}`;

  /* Belt and braces against a future prefix or digest-length change that would
     push it past what the provider accepts. */
  if (marker.length > LABEL_NAME_MAX) {
    throw fail("INTERNAL", "GRAV built a deployment marker the advertising channel cannot hold.", { field: "marker" });
  }
  return marker;
}

/**
 * Is this a marker GRAV minted, by shape?
 *
 * Not proof of anything — a shape check, used to refuse a caller-supplied
 * string before it reaches a provider query. Whether a marker is THE marker for
 * a command is answered by re-deriving it, never by parsing it.
 */
const looksLikeMarker = (value) => MARKER_PATTERN.test(str(value));

function assertMarker(value, field = "marker") {
  const v = str(value);
  if (!looksLikeMarker(v)) {
    throw fail("VALIDATION", "That is not a GRAV deployment marker.", { field });
  }
  return v;
}

module.exports = {
  markerFor,
  looksLikeMarker,
  assertMarker,
  PREFIX,
  MARKER_PATTERN,
  LABEL_NAME_MAX,
};
