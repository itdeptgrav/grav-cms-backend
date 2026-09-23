// services/marketing/channels/metaAdsWriteClient.js
//
// THE ONLY CODE IN GRAV THAT CHANGES ANYTHING IN A META ADVERTISING ACCOUNT.
//
// ── FIVE OPERATIONS. NO SIXTH. ─────────────────────────────────────────────
// There is no `post(path, body)` here, no generic Graph call, no way to reach a
// node this file does not name. `OPERATIONS` is the complete set: an image
// upload and four creates. A caller supplies a validated GRAV command and
// nothing else — no path, no method, no node, no field names.
//
// ── AND NOTHING IN IT CAN START DELIVERY ───────────────────────────────────
// Enforced four ways rather than asserted once:
//
//   1. Meta's word for a delivering object appears nowhere in this file as a
//      string. A test greps the comment-stripped source, so this sentence
//      would fail the suite if it spelled it.
//   2. `assertNonDelivering` walks every payload recursively immediately before
//      transport and refuses any status, at any depth, that is not the stopped
//      one.
//   3. No operation updates an existing object. There is no update verb, no
//      activate, no publish, no enable — and no delete either, deliberately
//      (see below).
//   4. `channelHttp.assertMutation` refuses a write that has not named itself
//      one, and this is one of only two files in the codebase that names it.
//
// ── WHY THERE IS NO DELETE ─────────────────────────────────────────────────
// A half-created campaign is left alone. Deleting objects after a failure means
// issuing more writes into an account GRAV has just proved it does not
// understand, and a delete that itself fails or times out makes the evidence
// worse rather than better. Everything GRAV creates is created stopped, so a
// half-built campaign is inert: it spends nothing and shows nothing. Inert and
// recorded beats tidied-up and uncertain.
//
// ── AND WHY THIS IS NOT ATOMIC ─────────────────────────────────────────────
// Meta has no documented all-or-nothing transaction across these nodes. `/batch`
// with `depends_on` is request batching with dependency resolution — each
// operation is evaluated independently and a failure part-way leaves earlier
// ones applied. So this is a SEQUENCE, each step confirmed and recorded before
// the next begins, which is what makes a partial outcome recoverable instead of
// unknowable.
"use strict";

const secrets = require("./channelSecrets");
const http = require("./channelHttp");
const { fail } = require("../../storePurchase/errors");
const {
  META_OBJECT_BY_CODE,
  CREATION_ORDER,
} = require("../../../constants/marketingMetaDeployment");

const CHANNEL = "meta_ads";
const API_VERSION = "v21.0";
const API_BASE = `https://graph.facebook.com/${API_VERSION}`;

const str = (v) => String(v ?? "").trim();

const assertDigits = (value, field) => {
  const v = str(value).replace(/^act_/, "");
  if (!/^\d{1,25}$/.test(v)) {
    throw fail("VALIDATION", "That is not an identifier this advertising channel uses.", { field });
  }
  return v;
};

const actId = (value, field) => `act_${assertDigits(value, field)}`;

/* ── THE STOPPED STATUS, ONCE ───────────────────────────────────────────────
   Read from the object table rather than written here, so the mapper, the
   validator and this client cannot drift apart about what "stopped" is. */
const STOPPED = META_OBJECT_BY_CODE.campaign.stoppedStatus;

/* ── THE COMPLETE SET OF THINGS GRAV CAN DO TO AN ACCOUNT ───────────────────
   `edge` is the only path segment any request uses, and it comes from here
   rather than from a caller. `role` ties each back to GRAV's own object
   vocabulary so the orchestrator never names a Graph node.

   The order of the keys is the documented creation order: a campaign before the
   ad set that references it, the creative before the ad that carries it. */
const OPERATIONS = Object.freeze({
  image: Object.freeze({
    role: "image",
    edge: "adimages",
    operation: "image.upload",
    /* An image has no status and is not an object that delivers — it is a file
       in the account's library that a creative points at. */
    carriesStatus: false,
  }),
  campaign: Object.freeze({
    role: "campaign",
    edge: "campaigns",
    operation: "campaign.create",
    carriesStatus: true,
  }),
  audience_group: Object.freeze({
    role: "audience_group",
    edge: "adsets",
    operation: "adSet.create",
    carriesStatus: true,
  }),
  creative: Object.freeze({
    role: "creative",
    edge: "adcreatives",
    operation: "creative.create",
    /* ── A CREATIVE DOES NOT DELIVER ──────────────────────────────────────
       It is a reusable description of what an advertisement looks like.
       Nothing is shown because of it and it cannot be paused. Describing one
       as paused would be the campaign-budget mistake again: an answer to a
       question it has not got. */
    carriesStatus: false,
  }),
  advertisement: Object.freeze({
    role: "advertisement",
    edge: "ads",
    operation: "ad.create",
    carriesStatus: true,
  }),
});

const OPERATION_CODES = Object.freeze(Object.keys(OPERATIONS));

/**
 * Refuse any payload carrying a status that could let an object deliver.
 *
 * Walks the whole structure. Meta nests an ad's status beside the ad and an ad
 * set's beside the ad set, and a check on the outermost object would miss both.
 * Applied to every payload immediately before transport, not to a sample.
 */
function assertNonDelivering(payload, { operation, path = "" }) {
  if (Array.isArray(payload)) {
    payload.forEach((item, i) => assertNonDelivering(item, { operation, path: `${path}[${i}]` }));
    return payload;
  }
  if (!payload || typeof payload !== "object") return payload;

  for (const [key, value] of Object.entries(payload)) {
    const here = path ? `${path}.${key}` : key;
    /* Meta spells it `status` on campaigns, ad sets and ads, and
       `effective_status` is a read-only computed field that must never be sent
       at all. Both are checked. */
    if (key === "status" || key === "effective_status") {
      if (str(value) !== STOPPED) {
        console.error(`[marketing-channel] ${CHANNEL} ${operation} refused: ${here} was ${str(value) || "(empty)"}`);
        throw fail("CHANNEL_UNSUPPORTED_OPERATION",
          "GRAV cannot start an advertising campaign. Every campaign it creates is created stopped.",
          { operation, field: here });
      }
    }
    assertNonDelivering(value, { operation, path: here });
  }
  return payload;
}

/**
 * Refuse a payload that would let the channel widen the approved audience.
 *
 * Meta's expansion settings show the advertisement to people OUTSIDE the
 * audience somebody approved. Omitting the field lets the channel's own default
 * decide, so GRAV writes it off explicitly — and this refuses a payload where
 * it is absent or on.
 */
function assertNoAudienceExpansion(payload, { operation }) {
  const targeting = payload?.targeting;
  if (!targeting || typeof targeting !== "object") return payload;

  for (const field of ["targeting_automation", "targeting_optimization"]) {
    const value = targeting[field];
    if (value === undefined) {
      throw fail("CHANNEL_UNSUPPORTED_OPERATION",
        "GRAV will not send an audience without saying that the advertising channel may not widen it.",
        { operation, field: `targeting.${field}` });
    }
    if (value && typeof value === "object" && Object.values(value).some((v) => v === 1 || v === true)) {
      throw fail("CHANNEL_UNSUPPORTED_OPERATION",
        "GRAV will not let the advertising channel show an advertisement outside the audience that was approved.",
        { operation, field: `targeting.${field}` });
    }
  }
  return payload;
}

function authHeaders(creds) {
  /* The token goes in a header, never in a query string: a query string is
     logged by every proxy between here and the channel. */
  return { Authorization: `Bearer ${creds.accessToken}` };
}

const httpAuthorise = async (env) => ({ creds: secrets.credentials(CHANNEL, env) });

/* ── THE TRANSPORT, AND WHY IT NEVER RETRIES ────────────────────────────────
   A create that timed out may have succeeded. A retry inside the transport
   would send it a second time with nothing recording the first, and Meta would
   create a second object. Retry is not a transport decision; it is a decision
   made against the attempt record after reconciliation, and this slice does not
   make it automatically at all. */
const httpTransport = async ({ url, headers, data, operation }) => http.perform({
  channel: CHANNEL,
  operation,
  method: "POST",
  mutationIntent: true,
  url,
  headers,
  data,
  retries: 0,
});

function readCreated(data, { operation }) {
  http.requireObject(data, { channel: CHANNEL, operation, what: "the response" });
  http.assertNoErrorEnvelope(data, { channel: CHANNEL, operation });

  const id = str(data.id);
  if (!id) {
    throw fail("CHANNEL_MALFORMED_RESPONSE",
      "The advertising channel accepted the request without saying what it created.",
      { channel: CHANNEL, operation });
  }
  return id;
}

/**
 * Upload the exact approved image bytes.
 *
 * ── THE BYTES, NOT A LINK ──────────────────────────────────────────────────
 * Meta is sent the picture itself and answers with its own hash for it. GRAV
 * never supplies that hash and never accepts one from a caller: a hash GRAV did
 * not receive from this upload names a picture nobody here has seen.
 *
 * The bytes come from the advertising image library, which re-verifies their
 * SHA-256 against the approved version every time they are read.
 */
async function uploadImage({ accountId, buffer, fileName, sha256 }, { transport, authorise, env = process.env } = {}) {
  const account = actId(accountId, "accountId");
  const spec = OPERATIONS.image;

  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw fail("VALIDATION", "There are no image bytes to upload.", { field: "buffer" });
  }
  if (!/^[0-9a-f]{64}$/.test(str(sha256))) {
    /* The caller has to say which approved version these bytes are, so the
       attempt record can name it. */
    throw fail("VALIDATION", "An image upload needs the identity of the approved version.", { field: "sha256" });
  }

  const send = transport || httpTransport;
  const { creds } = await (authorise || httpAuthorise)(env);

  const { data } = await send({
    operation: spec.operation,
    url: `${API_BASE}/${account}/${spec.edge}`,
    headers: authHeaders(creds),
    /* Meta's image edge takes the file as a named part whose key becomes the
       key in the response. The name is GRAV's, derived from the approved
       version's hash so the response can be matched to it. */
    data: { bytes: buffer, fileName: str(fileName) || `${sha256.slice(0, 12)}.img`, sha256 },
  });

  http.requireObject(data, { channel: CHANNEL, operation: spec.operation, what: "the response" });
  http.assertNoErrorEnvelope(data, { channel: CHANNEL, operation: spec.operation });

  /* Meta answers `{ images: { <name>: { hash, url } } }`. The hash is the only
     thing GRAV keeps, and it comes from here and nowhere else. */
  const images = data.images && typeof data.images === "object" ? data.images : null;
  const entry = images ? Object.values(images)[0] : null;
  const hash = str(entry?.hash);
  if (!hash) {
    throw fail("CHANNEL_MALFORMED_RESPONSE",
      "The advertising channel accepted the image without saying how to refer to it.",
      { channel: CHANNEL, operation: spec.operation });
  }

  return { providerImageHash: hash, sha256: str(sha256) };
}

/**
 * Create one object, stopped where it has a status.
 *
 * @param {object} args
 * @param {string} args.role      a key of `OPERATIONS`, in GRAV's vocabulary
 * @param {string} args.accountId the BOUND account. Never defaulted.
 * @param {object} args.payload   built by the mapper, validated here again
 */
async function create({ role, accountId, payload }, { transport, authorise, env = process.env } = {}) {
  const spec = OPERATIONS[str(role)];
  if (!spec || spec.role === "image") {
    throw fail("CHANNEL_UNSUPPORTED_OPERATION",
      "GRAV does not create that in an advertising channel.",
      { channel: CHANNEL, field: "role" });
  }
  const account = actId(accountId, "accountId");

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw fail("VALIDATION", "There is nothing to create.", { field: "payload" });
  }

  /* ── THE GATES, IMMEDIATELY BEFORE TRANSPORT ────────────────────────────
     Not at mapping time and not at preflight — here, on the exact object about
     to leave the process, because anything that modified it in between would
     otherwise go unchecked. */
  if (spec.carriesStatus) {
    if (str(payload.status) !== STOPPED) {
      throw fail("CHANNEL_UNSUPPORTED_OPERATION",
        "GRAV will not create a delivery-capable advertising object without the channel's stopped status on it.",
        { operation: spec.operation, field: "status" });
    }
  } else if (payload.status !== undefined) {
    /* ── AND A CREATIVE IS NOT GIVEN AN INVENTED ONE ──────────────────────
       It has no status. Sending one would either be rejected by the channel or,
       worse, silently accepted and recorded by GRAV as evidence that a thing
       with no delivery state is stopped. */
    throw fail("CHANNEL_UNSUPPORTED_OPERATION",
      "That advertising object has no delivery status, so GRAV will not give it one.",
      { operation: spec.operation, field: "status" });
  }

  assertNonDelivering(payload, { operation: spec.operation });
  assertNoAudienceExpansion(payload, { operation: spec.operation });

  const send = transport || httpTransport;
  const { creds } = await (authorise || httpAuthorise)(env);

  const { data } = await send({
    operation: spec.operation,
    url: `${API_BASE}/${account}/${spec.edge}`,
    headers: authHeaders(creds),
    data: payload,
  });

  return { role: spec.role, providerObjectId: readCreated(data, { operation: spec.operation }) };
}

module.exports = {
  CHANNEL,
  API_VERSION,
  OPERATIONS,
  OPERATION_CODES,
  CREATION_ORDER,
  uploadImage,
  create,
  /* Exported for the suites that prove the gates without a transport. Neither
     can send anything. */
  assertNonDelivering,
  assertNoAudienceExpansion,
  STOPPED,
};
