// routes/CMS_Routes/Marketing/googleLeadWebhook.js
//   → mounted at /api/cms/marketing
//
// WHERE GOOGLE POSTS A SUBMITTED LEAD.
//
//   POST /google-leads/:deliveryToken
//
// ── THE ONLY UNAUTHENTICATED ROUTE IN MARKETING ────────────────────────────
// Google is not a GRAV user, holds no session and knows nothing about
// companies. So browser authentication is not merely unnecessary here, it is
// impossible — and that makes this the one door where the trust has to be
// built out of the request itself, in a fixed order:
//
//   1. the route token has a valid signature      → which binding
//   2. that binding exists and is enabled          → is it still listening
//   3. the derived key matches                     → is this really Google
//   4. the payload agrees with the binding         → is it this form's lead
//
// Nothing in the body is believed before step 3. In particular the company is
// never taken from the payload: `campaign_id` and `form_id` are values a sender
// chose, and letting one select a tenant would let anybody post a lead into any
// company whose campaign number they could guess.
//
// ── AND THE ANSWERS ARE GOOGLE'S, NOT GRAV'S ───────────────────────────────
// From its Lead handling table: 200 with `{}`, 4XX never retried, 5XX retried.
// The mapping is load-bearing. A wrong key must be 4XX — it will not become
// right on a retry. A GRAV fault must be 5XX, or a real enquiry is lost because
// a database was briefly busy. A duplicate must be 200, or Google keeps
// redelivering something that already arrived safely.
"use strict";

const express = require("express");

const router = express.Router();

const W = require("../../../constants/marketingGoogleLeadWebhook");
const bindings = require("../../../services/marketing/leads/leadDeliveryBinding.service");
const keys = require("../../../services/marketing/leads/leadWebhookKey");
const normalisation = require("../../../services/marketing/leads/googleLeadNormalisation");
const ingestion = require("../../../services/marketing/leads/leadIngestion.service");
const processing = require("../../../services/marketing/leads/leadProcessing.service");

const str = (v) => String(v ?? "").trim();

/* ── GOOGLE'S OWN OUTCOMES ──────────────────────────────────────────────────
   One place, so a handler cannot invent a status. The body for a refusal is
   `{message}` as documented, and the message is always GRAV's own wording —
   never a driver error, a collection name, a binding identity or anything
   about the secret. */
function answer(res, outcome, message = "") {
  const spec = W.RESPONSES[outcome] || W.RESPONSES.TRY_AGAIN;
  if (spec.status === 200) return res.status(200).json({});
  return res.status(spec.status).json({ message: str(message) || "Refused." });
}

/* ── INT64-SAFE PARSING ─────────────────────────────────────────────────────
   Google says four times that its identifiers are 8-byte integers. A JSON
   number above 2^53 loses its last digits through an ordinary parse, silently,
   and the correlation those ids exist for then matches nothing.

   This uses the parser's own source access rather than a regular expression
   over the raw text: a regex would have to re-implement JSON's own rules about
   strings, escapes and nesting, and would eventually read a number out of
   something that only looked like one. Here the parser decides what a number
   is, and hands back exactly the characters it saw. */
function parseInt64Safe(text) {
  return JSON.parse(text, function reviveExactNumbers(key, value, context) {
    if (typeof value === "number" && context && typeof context.source === "string") {
      /* Only the identifiers Google documents as int64. Everything else keeps
         its ordinary type, so a boolean stays a boolean and a small number
         stays a number. */
      if (W.INT64_FIELDS.includes(key)) return context.source;
    }
    return value;
  });
}

/* Collected as text so an oversized body is refused before it is parsed —
   `express.json` would happily build the whole object first.
 *
 * ── AN OVERSIZE BODY IS ANSWERED, NOT HUNG UP ON ──────────────────────────
 * The obvious implementation destroys the socket the moment the limit is
 * passed. That is wrong here in a way Google's own contract makes expensive: a
 * connection reset is not one of its documented outcomes, and its table treats
 * anything that is not a 4XX as retryable — so a body GRAV will never accept
 * would be redelivered for as long as Google keeps trying.
 *
 * So reading stops, the remainder is drained so the socket closes cleanly, and
 * the handler sends a 4XX that tells Google not to come back.
 */
function readBody(req, limit) {
  /* ── ALREADY READ BY THE APP'S JSON PARSER ────────────────────────────────
     server.js parses JSON globally and stashes the exact bytes on `rawBody`.
     Once that parser has consumed the stream, no `data` or `end` event will
     ever arrive again — waiting for them left Google's delivery hanging with
     no answer at all. So the stashed bytes are used, under this route's own
     limit, exactly as if they had been read here. */
  if (req._body || req.readableEnded) {
    const buf = Buffer.isBuffer(req.rawBody) ? req.rawBody
      : Buffer.isBuffer(req.body) ? req.body
        : Buffer.from(req.body === undefined ? "" : JSON.stringify(req.body), "utf8");
    return Promise.resolve(buf.length > limit
      ? { oversize: true, text: "" }
      : { oversize: false, text: buf.toString("utf8") });
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    let oversize = false;
    const chunks = [];

    req.on("data", (chunk) => {
      if (oversize) return;
      size += chunk.length;
      if (size > limit) {
        oversize = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(oversize
      ? { oversize: true, text: "" }
      : { oversize: false, text: Buffer.concat(chunks).toString("utf8") }));
    req.on("error", reject);
  });
}

/**
 * POST /google-leads/:deliveryToken
 *
 * No `marketingAuth`. See the header: the caller is Google, and the trust is
 * the signed token plus the derived key.
 */
router.post("/google-leads/:deliveryToken", async (req, res) => {
  try {
    /* JSON only. Google sends `application/json`; anything else is either a
       misconfiguration or somebody probing. */
    const contentType = str(req.headers["content-type"]).toLowerCase();
    if (contentType && !contentType.includes("application/json")) {
      return answer(res, "REFUSED", "That delivery was not JSON.");
    }

    let body;
    try {
      body = await readBody(req, W.LIMITS.BODY_BYTES);
    } catch {
      /* A connection that dropped mid-body is worth retrying — the next
         attempt may well arrive whole. */
      return answer(res, "TRY_AGAIN", "That delivery could not be read.");
    }
    if (body.oversize) {
      return answer(res, "REFUSED", "That delivery was too large.");
    }
    const raw = body.text;

    let payload;
    try {
      payload = parseInt64Safe(raw);
    } catch {
      return answer(res, "REFUSED", "That delivery could not be read as JSON.");
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return answer(res, "REFUSED", "That delivery was not an object.");
    }

    /* ── 1. WHICH BINDING ────────────────────────────────────────────────
       Before a single value from the body is trusted. */
    const binding = await bindings.resolveForDelivery(str(req.params.deliveryToken));
    if (!binding) {
      /* A forged token, an unknown one and one for a deleted binding are one
         answer. Telling them apart would let somebody map which addresses
         exist by watching the differences. */
      return answer(res, "REFUSED", "That delivery address is not one GRAV recognises.");
    }

    /* ── 2. IS IT STILL LISTENING ────────────────────────────────────────
       A disabled binding is a permanent refusal: retrying will not re-enable
       it, and telling Google to keep trying would have it redeliver for days. */
    if (binding.state === "disabled") {
      return answer(res, "REFUSED", "That delivery address is no longer accepting leads.");
    }

    /* ── 3. IS IT REALLY GOOGLE ──────────────────────────────────────────
       Both documented spellings are read. A body carrying BOTH with different
       values is refused outright rather than resolved by preference: it is
       not something Google sends, so it is somebody trying one of each to see
       which GRAV checks. */
    const supplied = [];
    for (const field of W.KEY_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(payload, field)) {
        const value = str(payload[field]);
        if (value) supplied.push(value);
      }
    }
    if (supplied.length > 1 && new Set(supplied).size > 1) {
      return answer(res, "REFUSED", "That delivery was not accepted.");
    }

    const identity = bindings.derivationIdentity(binding);
    let verified = false;
    try {
      verified = keys.verifyWebhookKey({ supplied: supplied[0] || "", ...identity });
    } catch (err) {
      /* A configuration problem, not the sender's fault. Retryable, because
         somebody may be about to configure it — and the administrator-facing
         reason goes to the log, never to Google. */
      console.error(`[google-lead-webhook] key unavailable: ${err.code}`);
      return answer(res, "TRY_AGAIN", "That delivery could not be processed.");
    }

    if (!verified) {
      /* A wrong key will not become right on a retry. The message says
         nothing about the key, its length, or which spelling was used. */
      return answer(res, "UNVERIFIED", "That delivery was not accepted.");
    }

    /* ── 4. IS IT THIS FORM'S LEAD ───────────────────────────────────────
       Only now, with the delivery proven to be Google's, are the payload's own
       identifiers worth anything. This is a correlation check, not a lookup:
       the binding was already chosen by the token.

       A binding that has not yet learned its form identity tolerates not
       knowing — a lead can legitimately arrive between creating a form and
       recording what was created. */
    const normalised = normalisation.normalise({
      via: "webhook",
      payload,
      /* The int64 fields came back from the parser as exact text. */
      rawIds: Object.fromEntries(W.INT64_FIELDS.map((f) => [f, str(payload[f])])),
    });

    if (!normalised.ok) {
      return answer(res, "REFUSED", "That delivery was missing something GRAV needs.");
    }

    const claimedForm = str(normalised.lead.correlation?.formId);
    if (binding.providerFormId && claimedForm && binding.providerFormId !== claimedForm) {
      /* Verified as Google's, but for a different form than this address
         belongs to. Permanent: redelivering will not change which form it
         came from. */
      return answer(res, "REFUSED", "That delivery does not belong to this address.");
    }

    /* ── AND ONLY NOW IS ANYTHING WRITTEN ────────────────────────────────── */
    const outcome = await ingestion.record({ binding, lead: normalised.lead });

    if (outcome.outcome === ingestion.OUTCOMES.CONFLICT) {
      return answer(res, "REFUSED", "That delivery was missing something GRAV needs.");
    }

    /* ── GOOGLE IS ANSWERED BEFORE THE SLOW WORK ─────────────────────────
       The 200 depends only on the submission being durably recorded. Identity
       resolution, engagement and consent involve several more writes, and
       holding Google's connection open for them would risk its timeout — at
       which point it redelivers a lead GRAV already has, for as long as it
       keeps trying.

       So the answer goes first and processing is detached. It is safe to
       detach precisely because it is idempotent and resumable: the receipt is
       keyed on the submission, so a crash, a restart or a later sweep picks up
       exactly where this left off, and a failure here can never make Google
       redeliver something already recorded. */
    if (outcome.outcome === ingestion.OUTCOMES.RECORDED) {
      const submissionRef = outcome.submissionRef;
      const companyId = binding.companyId;
      setImmediate(() => {
        processing.process({ companyId, submissionRef }).catch((err) => {
          /* Never fatal to the delivery — the enquiry is already safe, and the
             receipt records that processing has not finished. */
          console.error(`[lead-processing] deferred run failed: ${str(err?.message).slice(0, 200)}`);
        });
      });
    }

    /* Recorded, already had it, or a test that was noted — all 200 `{}`.
       Google is told the lead is safely handled and need not send it again. */
    return answer(res, "ACCEPTED");
  } catch (err) {
    /* ── A GRAV FAULT IS RETRYABLE, AND SAYS NOTHING ─────────────────────
       The alternative loses a real enquiry because a database was briefly
       busy. The detail goes to the log; Google gets a sentence. */
    console.error("[google-lead-webhook] unhandled:", err?.message || err);
    return answer(res, "TRY_AGAIN", "That delivery could not be processed.");
  }
});

module.exports = router;
