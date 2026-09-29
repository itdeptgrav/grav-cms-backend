// services/marketing/mauticWebhookContract.js
//
// TRANSLATING WHAT MAUTIC ACTUALLY SENDS INTO WHAT THE LEDGER STORES.
//
// ── THE THREE THINGS REAL MAUTIC DOES THAT A GUESS WOULD NOT ───────────────
// Read from `mautic/core-lib` at 7.x on 9 September 2026 —
// `bundles/WebhookBundle/Http/Client.php` and `Model/WebhookModel.php`:
//
//   1. THE SIGNATURE IS BASE64, NOT HEX, AND THE HEADER IS `Webhook-Signature`.
//        base64_encode(hash_hmac('sha256', $jsonPayload, $secret, true))
//      Not `X-Hub-Signature-256`, not `sha256=<hex>`. An endpoint written from
//      the GitHub/Meta convention rejects every genuine Mautic delivery, and
//      the symptom — 401s that look like a wrong secret — sends people to
//      rotate a credential that was never the problem.
//
//   2. ONE POST CARRIES MANY EVENTS, GROUPED BY TYPE.
//        { "mautic.form_on_submit": [ {...}, {...} ],
//          "mautic.page_on_hit":    [ {...} ] }
//      Not one event per request. An intake that reads the body as a single
//      event silently drops everything after the first.
//
//   3. AN ITEM HAS NO EVENT ID OF ITS OWN.
//      Mautic injects only `timestamp` into each item. There is no delivery id
//      and no queue id to deduplicate on — which matters more here than
//      anywhere else, because Mautic RETRIES, and the ledger's whole guarantee
//      is a unique key. So the id is DERIVED from the type plus the identity
//      of the underlying record (`submission.id`, `stat.id`, `hit.id`), and an
//      item whose record has no id is REJECTED rather than stored under an
//      invented one. An id we made up cannot deduplicate anything, and storing
//      the event anyway would make the ledger's guarantee quietly false for
//      exactly the events most likely to be replayed.
//
// ── WHAT IS DELIBERATELY NOT TRANSLATED ────────────────────────────────────
// `mautic.lead_post_save_*`, `mautic.email_on_send`,
// `mautic.lead_channel_subscription_changed` and everything else. Chunk 0
// proves the round trip; unsubscribe and bounce suppression is Chunk 2's, and
// mapping it here without the suppression behaviour behind it would record a
// withdrawal of consent that nothing acts on. Unmapped types are reported as
// ignored, by name — never dropped in silence and never retried for ever.
"use strict";

const crypto = require("crypto");

const str = (v) => String(v ?? "").trim();
const lower = (v) => str(v).toLowerCase();

/* The header Mautic actually sends, plus the two a hand-rolled sender or an
   earlier version of this endpoint might. Mautic's own is checked first. */
const SIGNATURE_HEADERS = Object.freeze([
  "webhook-signature",        // Mautic 7.x — base64
  "x-mautic-signature",       // GRAV's own synthetic sender
  "x-hub-signature-256",      // the GitHub/Meta convention
]);

/**
 * Verify a webhook signature against the RAW bytes.
 *
 * Accepts both encodings because both reach this endpoint: real Mautic sends
 * base64, and GRAV's own synthetic sender and test harness send hex. Both are
 * compared in constant time against the same HMAC, so accepting two encodings
 * widens the format and not the trust — a wrong secret fails either way.
 *
 * With no secret configured the answer is NO. A verification that passes when
 * unconfigured is not a verification: it is an open endpoint that looks
 * guarded, and the environments where nobody sets the secret are exactly the
 * ones nobody is watching.
 */
function verifySignature(rawBody, signature, secret = process.env.MAUTIC_WEBHOOK_SECRET) {
  const key = str(secret);
  if (!key) return { ok: false, reason: "No Mautic webhook secret is configured." };

  const provided = str(signature).replace(/^sha256=/i, "");
  if (!provided) return { ok: false, reason: "The request carried no signature." };

  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(str(rawBody), "utf8");
  const mac = crypto.createHmac("sha256", key).update(body).digest();

  const candidates = [mac.toString("base64"), mac.toString("hex")];
  for (const expected of candidates) {
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(provided.length === expected.length ? provided : "", "utf8");
    /* Length first: timingSafeEqual throws on a mismatch, and the throw would
       itself leak the length. A hex signature simply fails the base64
       comparison on length and is caught by the next candidate. */
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      return { ok: true, reason: "", encoding: expected === candidates[0] ? "base64" : "hex" };
    }
  }
  return { ok: false, reason: "The signature did not match." };
}

/** Pull the signature out of whichever header carried it. */
function signatureFrom(headers = {}) {
  const get = (name) => (typeof headers.get === "function" ? headers.get(name) : headers[name]);
  for (const name of SIGNATURE_HEADERS) {
    const value = str(get(name));
    if (value) return { value, header: name };
  }
  return { value: "", header: "" };
}

/* ── THE DETERMINISTIC SOURCE-EVENT KEY ─────────────────────────────────────
   Mautic gives a webhook item no id of its own. It injects only a `timestamp`,
   and the item's position in the array is meaningless — a re-delivery may batch
   the same events in a different order, or split them across two requests.
   So the key is DERIVED, and the derivation is the contract:

       "<mautic event type>:<record type>:<record id>[:<discriminator>]"

   The rules it has to satisfy, and how each is met:

     identical on replay        every part comes from a provider fact that does
                                not change when the same event is re-sent
     different for distinct
     events                     the record id is the provider's own primary key
                                for the thing that happened (a submission, a
                                hit, a send stat, a do-not-contact row)
     tolerant of batching       nothing reads the array, its length or the
                                position of the item within it
     never positional           there is no index anywhere in the derivation
     never receipt-dependent    `receivedAt` appears nowhere; the provider's own
                                `timestamp` is used only where the record itself
                                has no id, and it is a property of the event
                                rather than of our reading of it
     stable across re-batching  two requests carrying the same item produce
                                byte-identical keys

   THE ONE AWKWARD CASE is the channel-subscription change, which Mautic emits
   with no id for the change itself. Where the contact's `doNotContact[]` carries
   the row that caused it, that row's id is used — a real provider primary key.
   Where it does not, the key falls back to contact + channel + the status pair +
   the provider timestamp, which is stable for a replay of the same delivery and
   is the best the payload supports. That limitation is real and is stated here
   rather than hidden. */

/* Mautic's own status verbs on a channel-subscription change, from
   DoNotContact: IS_CONTACTABLE=0, UNSUBSCRIBED=1, BOUNCED=2, MANUAL=3. */
const SUBSCRIPTION_KIND = Object.freeze({
  unsubscribed: "email_unsubscribed",
  bounced: "email_bounced",
  /* Somebody inside Mautic marked the contact do-not-contact. It is a
     withdrawal, whoever performed it, and suppression treats it as one. */
  manual: "email_unsubscribed",
  contactable: "email_resubscribed",
});

/* ── HARD OR SOFT, FROM THE PROVIDER'S OWN WORDS ────────────────────────────
   Matched on the vocabulary SMTP servers actually use for a permanent failure.
   Anything unmatched is `unknown` — NOT soft. Guessing "soft" on an unreadable
   reason would keep sending to an address that may not exist; guessing "hard"
   would delete a real customer on the strength of a string nobody parsed. */
const HARD_BOUNCE = /\b(5\.[0-7]\.\d+|550|551|553|554|no such user|user unknown|unknown user|mailbox unavailable|does not exist|invalid recipient|recipient rejected|address rejected|account (?:is )?disabled|no longer (?:in use|valid))\b/i;
const SOFT_BOUNCE = /\b(4\.\d\.\d+|421|450|451|452|mailbox full|over quota|quota exceeded|temporarily|try again later|greylist|deferred|timed? out)\b/i;

function classifyBounce(reasonText) {
  const t = str(reasonText);
  if (!t) return "unknown";
  if (HARD_BOUNCE.test(t)) return "hard";
  if (SOFT_BOUNCE.test(t)) return "soft";
  return "unknown";
}

/* ── THE TYPES THIS APPLICATION UNDERSTANDS ─────────────────────────────────
   Each returns the identity of the event, its kind, whose it is, when it
   happened, and the bounded evidence worth keeping. `idPart` is appended to the
   Mautic event type to form the source-event key.

   WHAT MAUTIC 7.2.0 DOES NOT OFFER, verified against the live instance's own
   `GET /api/hooks/triggers`: there is no delivery trigger and no bounce
   trigger. `email_delivered` is therefore never observed by this integration,
   and a bounce reaches GRAV only as a channel-subscription change to
   "bounced". Both kinds are modelled anyway — the domain has six facts whether
   or not one provider reports them all — and the two hypothetical trigger names
   a plugin would use are accepted so the contract is ready without a change. */
const TRANSLATORS = {
  "mautic.form_on_submit": (item) => {
    const s = item?.submission || {};
    const id = str(s.id);
    if (!id) return { rejected: "A form submission with no id cannot be deduplicated." };
    return {
      idPart: `submission:${id}`,
      kind: "form_submitted",
      contact: s.lead || s.contact || {},
      emailFallback: s.results?.email,
      occurredAt: s.dateSubmitted || item?.timestamp,
      assetName: str(s.form?.name),
      topics: topicsFromResults(s.results),
      evidence: {
        providerRecordType: "submission",
        providerRecordId: id,
        formId: str(s.form?.id),
        /* Keys, never answers. */
        resultKeys: Object.keys(s.results || {}).slice(0, 40),
      },
    };
  },

  "mautic.page_on_hit": (item) => {
    const h = item?.hit || {};
    const id = str(h.id);
    if (!id) return { rejected: "A page hit with no id cannot be deduplicated." };
    /* A hit carrying an email reference IS the click-through from a campaign
       email; Mautic 7 has no separate click trigger. Calling an ordinary page
       view a click would inflate every intent assessment downstream. */
    const fromEmail = Boolean(h.email?.id || h.emailId);
    return {
      idPart: `hit:${id}`,
      kind: fromEmail ? "email_clicked" : "page_viewed",
      contact: h.lead || h.contact || {},
      emailFallback: h.emailAddress,
      occurredAt: h.dateHit || item?.timestamp,
      assetName: str(h.page?.title || h.email?.name || h.url),
      topics: [],
      evidence: {
        providerRecordType: "hit",
        providerRecordId: id,
        emailId: str(h.email?.id || h.emailId),
        url: str(h.url).slice(0, 500),
      },
    };
  },

  "mautic.email_on_open": (item) => {
    const s = item?.stat || {};
    const id = str(s.id);
    if (!id) return { rejected: "An email-open stat with no id cannot be deduplicated." };
    return {
      idPart: `stat:${id}`,
      kind: "email_opened",
      contact: s.lead || s.contact || {},
      emailFallback: s.emailAddress,
      occurredAt: s.dateRead || item?.timestamp,
      assetName: str(s.email?.name || s.emailName),
      topics: [],
      evidence: {
        providerRecordType: "stat",
        providerRecordId: id,
        emailId: str(s.email?.id),
      },
    };
  },

  "mautic.email_on_send": (item) => {
    /* The send payload carries the stat under `stat`, and older shapes put the
       email under `email` with the contact beside it. The stat id is the
       provider key either way. */
    const s = item?.stat || item || {};
    const id = str(s.id);
    if (!id) return { rejected: "An email-send stat with no id cannot be deduplicated." };
    return {
      idPart: `stat:${id}`,
      kind: "email_sent",
      contact: s.lead || s.contact || item?.contact || {},
      emailFallback: s.emailAddress,
      occurredAt: s.dateSent || item?.timestamp,
      assetName: str(s.email?.name || item?.email?.name),
      topics: [],
      evidence: {
        providerRecordType: "stat",
        providerRecordId: id,
        emailId: str(s.email?.id || item?.email?.id),
      },
    };
  },

  /* Not emitted by Mautic 7.2.0 core. Accepted so a plugin that reports real
     provider delivery has somewhere to land without a contract change. */
  "mautic.email_on_delivered": (item) => {
    const s = item?.stat || item || {};
    const id = str(s.id);
    if (!id) return { rejected: "A delivery stat with no id cannot be deduplicated." };
    return {
      idPart: `stat:${id}`,
      kind: "email_delivered",
      contact: s.lead || s.contact || {},
      emailFallback: s.emailAddress,
      occurredAt: s.dateDelivered || s.dateSent || item?.timestamp,
      assetName: str(s.email?.name),
      topics: [],
      evidence: { providerRecordType: "stat", providerRecordId: id, emailId: str(s.email?.id) },
    };
  },

  /* Likewise hypothetical in core; a bounce reaches 7.2.0 as a subscription
     change. Modelled because a plugin or a later release may emit it directly,
     and because the hard/soft distinction has to live somewhere either way. */
  "mautic.email_on_bounce": (item) => {
    const s = item?.stat || item || {};
    const id = str(s.id);
    if (!id) return { rejected: "A bounce stat with no id cannot be deduplicated." };
    const reasonText = str(s.reason || s.comments || item?.reason);
    return {
      idPart: `stat:${id}`,
      kind: "email_bounced",
      contact: s.lead || s.contact || {},
      emailFallback: s.emailAddress,
      occurredAt: s.dateBounced || s.dateSent || item?.timestamp,
      assetName: str(s.email?.name),
      topics: [],
      bounceClass: classifyBounce(reasonText),
      evidence: {
        providerRecordType: "stat", providerRecordId: id,
        emailId: str(s.email?.id), reasonText: reasonText.slice(0, 300),
      },
    };
  },

  /* ── THE ONE THAT CARRIES BOTH UNSUBSCRIBE AND BOUNCE IN 7.2.0 ────────── */
  "mautic.lead_channel_subscription_changed": (item) => {
    const contact = item?.contact || item?.lead || {};
    const channel = str(item?.channel).toLowerCase() || "email";
    const newStatus = str(item?.new_status || item?.newStatus).toLowerCase();
    const oldStatus = str(item?.old_status || item?.oldStatus).toLowerCase();

    const kind = SUBSCRIPTION_KIND[newStatus];
    if (!kind) {
      return { rejected: `Unrecognised channel-subscription status "${newStatus || "(none)"}".` };
    }
    /* Only the email channel concerns this integration. An SMS unsubscribe is a
       real event about a channel GRAV does not yet send on; recorded as
       unsupported rather than silently suppressing an email address. */
    if (channel !== "email") {
      return { rejected: `Channel-subscription change on "${channel}", which this integration does not model.` };
    }

    /* The do-not-contact row that caused it, where the payload carries one —
       a real provider primary key, and the best identity available. */
    const dnc = (Array.isArray(contact.doNotContact) ? contact.doNotContact : [])
      .find((d) => str(d?.channel).toLowerCase() === "email" && str(d?.id));
    const reasonText = str(dnc?.comments);

    const idPart = dnc
      ? `dnc:${str(dnc.id)}`
      /* No id for the change. Contact, channel, the status transition and the
         provider's own timestamp — stable for a replay of the same delivery,
         and the most the payload supports. Documented as the weakest key in the
         contract because it is. */
      : `contact:${str(contact.id)}:${channel}:${oldStatus}>${newStatus}:${str(item?.timestamp)}`;

    return {
      idPart,
      kind,
      contact,
      occurredAt: dnc?.dateAdded || item?.timestamp,
      assetName: "",
      topics: [],
      previousStatus: oldStatus,
      newStatus,
      bounceClass: kind === "email_bounced" ? classifyBounce(reasonText) : "",
      evidence: {
        providerRecordType: dnc ? "doNotContact" : "channelSubscription",
        providerRecordId: str(dnc?.id),
        reasonText: reasonText.slice(0, 300),
      },
    };
  },
};

/* ── WHERE A CONTACT'S EMAIL ACTUALLY LIVES IN A WEBHOOK PAYLOAD ────────────
   Observed against a real Mautic 7.2.0 delivery on 10 September 2026, and it is
   NOT where the REST API puts it. `GET /api/contacts/{id}` returns a flat
   `fields.all.email`; the WEBHOOK serializer instead emits field GROUPS, each
   holding a full descriptor per field:

     stat.lead.fields = { core: { email: { id, label, alias, type, group,
                                          value, normalizedValue, … }, … },
                          social: {…}, personal: {…}, professional: {…} }

   There is no `lead.email` at all. The first version of this file looked for
   `contact.email || contact.fields.all.email`, found neither, and recorded the
   event with an empty email — attribution surviving only because the contact id
   was also present. A handover built from such a row would have had no address
   for Sales to write to.

   So every known location is checked, cheapest first, and the event-specific
   fallback (`stat.emailAddress`) is passed in by the translator that has it. */
const FIELD_GROUPS = ["core", "professional", "personal", "social"];

function contactEmailOf(contact = {}, fallback = "") {
  const direct = lower(contact.email);
  if (direct) return direct;

  const flat = lower(contact.fields?.all?.email);
  if (flat) return flat;

  for (const group of FIELD_GROUPS) {
    const cell = contact.fields?.[group]?.email;
    /* A descriptor, not a value: the address is under `.value`. `normalizedValue`
       is Mautic's own lowercased copy and is accepted when `value` is absent. */
    const v = lower(cell?.value || cell?.normalizedValue);
    if (v) return v;
  }
  return lower(fallback);
}

/** Form answers whose field looks like a topic of interest. Free-text answers
 *  are carried; a checkbox array is flattened. Nothing is inferred from a
 *  field this does not recognise. */
function topicsFromResults(results = {}) {
  const out = [];
  for (const [field, value] of Object.entries(results || {})) {
    if (!/interest|topic|product|requirement|category/i.test(field)) continue;
    if (Array.isArray(value)) out.push(...value.map(str));
    else if (str(value)) out.push(str(value));
  }
  return [...new Set(out.filter(Boolean))];
}

/**
 * Translate one Mautic webhook body into ledger events.
 *
 * Never throws for content: an unmapped type or an unusable item is REPORTED,
 * so the route can answer 200 with the rejections listed and Mautic stops
 * resending something that will never be accepted.
 *
 * @param {object} body      the parsed Mautic payload
 * @param {object} defaults  campaign context the payload does not carry
 * @returns {{events:Array, ignored:Array, rejected:Array}}
 */
function translate(body = {}, defaults = {}) {
  const events = [];
  const ignored = [];
  const rejected = [];

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { events, ignored, rejected: [{ reason: "The webhook body was not a Mautic event payload." }] };
  }

  for (const [type, items] of Object.entries(body)) {
    if (!Array.isArray(items)) continue;      // `timestamp` at the envelope level, etc.

    const translator = TRANSLATORS[type];
    if (!translator) {
      /* Named, not silent. "We received 40 of a type we do not handle" is a
         thing an operator needs to be able to see. */
      ignored.push({ type, count: items.length });
      continue;
    }

    for (const item of items) {
      let out;
      try {
        out = translator(item);
      } catch (err) {
        rejected.push({ type, reason: str(err?.message).slice(0, 200) });
        continue;
      }
      if (out?.rejected) {
        rejected.push({ type, reason: out.rejected });
        continue;
      }

      const contact = out.contact || {};
      const email = contactEmailOf(contact, out.emailFallback);
      const externalContactId = str(contact.id);

      if (!email && !externalContactId) {
        rejected.push({ type, reason: "The event names no contact — it cannot be attributed to anybody." });
        continue;
      }

      events.push({
        source: "mautic",
        /* The type is part of the key, not just the record id: two different
           event families could otherwise collide on a shared numeric id. */
        sourceEventId: `${type}:${out.idPart}`,
        kind: out.kind,
        email,
        externalContactId,
        campaignId: str(defaults.campaignId),
        campaignName: str(defaults.campaignName),
        assetName: out.assetName,
        topics: out.topics || [],
        occurredAt: out.occurredAt || item?.timestamp || null,
        bounceClass: str(out.bounceClass),
        previousStatus: str(out.previousStatus),
        newStatus: str(out.newStatus),
        /* Bounded and redacted. The provider's whole item is deliberately NOT
           carried forward — see the ledger model for what that cost. */
        evidence: {
          ...(out.evidence || {}),
          providerEventType: type,
          providerTimestamp: str(item?.timestamp),
        },
      });
    }
  }

  return { events, ignored, rejected };
}

module.exports = {
  verifySignature, signatureFrom, translate, classifyBounce, SUBSCRIPTION_KIND,
  contactEmailOf, SIGNATURE_HEADERS, TRANSLATORS, FIELD_GROUPS,
};
