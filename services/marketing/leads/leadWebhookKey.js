// services/marketing/leads/leadWebhookKey.js
//
// THE GOOGLE LEAD-FORM WEBHOOK KEY — DERIVED, NEVER STORED.
//
// ── WHY THERE IS NO VAULT HERE ─────────────────────────────────────────────
// Google's contract is unusually forgiving on this one point: the advertiser
// chooses the webhook key, and Google only ever hands it back inside the
// delivery. GRAV never has to retrieve it — it has to RECOGNISE it.
//
// Anything GRAV can recompute, it does not have to keep. So the key for a given
// company and form is derived from one deployment master secret at the moment
// it is needed, twice in the life of a form: once when configuring Google, once
// per delivery when checking one. Between those moments it does not exist
// anywhere.
//
// What that buys, precisely: a dumped database yields advertising-account
// numbers and binding identities, which are not credentials, and no webhook key
// for any company. An attacker needs the deployment master as well, and the
// master lives where the other deployment credentials live, not in Mongo.
//
// ── AND WHAT IT COSTS, SAID PLAINLY ────────────────────────────────────────
// One master secret is a single point of compromise for every company's webhook
// keys at once. That is a real blast radius and it is the trade being made:
// against a database dump — far and away the likelier event — it is a complete
// defence; against a compromised deployment environment it is no defence at
// all, because that environment holds the advertising credentials too.
//
// The mitigation is the key ring below. A master can be retired without
// touching bindings that were derived under an older one, because each binding
// records the version it was born with.
//
// ── THE DERIVATION LIVES ONLY HERE ─────────────────────────────────────────
// No caller reproduces it. A second implementation is a second chance to get
// the domain separation, the length-prefixing or the version wrong, and the
// symptom would be a webhook that verifies nothing while appearing to work.
"use strict";

const crypto = require("crypto");

/* ── THE KEY RING ───────────────────────────────────────────────────────────
   Version → the environment variable holding that generation's master.

   A ring rather than one permanently-named variable, because rotation is a
   thing that happens and a single `..._SECRET` name forces every existing form
   to break the day somebody changes it. A binding records the version it was
   created under and keeps deriving with that one for life.

   Adding a generation is an entry here plus the variable. Nothing else moves. */
const KEY_RING = Object.freeze({
  1: "MARKETING_GOOGLE_LEAD_WEBHOOK_MASTER_SECRET_V1",
});

const CURRENT_VERSION = 1;

/* ── DOMAIN SEPARATION ──────────────────────────────────────────────────────
   The purpose string is the HKDF salt, and it carries its own version.

   Without it, the same master used for two different things produces related
   keys, and a weakness in either becomes a weakness in both. This string is the
   reason a webhook key can never collide with anything else GRAV might one day
   derive from the same material — and the `.v1` in it means the derivation
   itself can be changed later without a key silently staying the same. */
const PURPOSE = "grav.marketing.google-lead-webhook.v1";

/* 256 bits, exactly. `openssl rand -hex 32` produces it. */
const MASTER_BYTES = 32;
const MASTER_HEX_CHARS = 64;
const DERIVED_BYTES = 32;

/* ── SECRETS THAT MAY NEVER BE USED HERE ────────────────────────────────────
   Named so a future edit that reaches for a convenient existing variable is
   refused loudly rather than working.

   Each already means something else. `SALARY_ENCRYPTION_KEY` protects payroll;
   deriving advertising secrets from it makes one leak into two, across
   completely unrelated domains. `MARKETING_CHANNEL_ID_SECRET` signs the public
   identifiers this very system hands to browsers — a key that is, by design,
   exercised by anyone who can open a page. `JWT_SECRET` is authentication:
   compromise it and the webhook key is the least of it. */
/* Key MATERIAL only. A third-party service's API credential is not on this
   list — nobody would derive a key from one, and naming it here would break a
   stronger guarantee elsewhere: the Campaign Health suite walks every file
   under `services/marketing/` to prove none of them names the model key, which
   is what keeps the provider gateway the only route to a model. A decorative
   entry on a denylist is not worth eroding that. */
const FORBIDDEN_SOURCES = Object.freeze([
  "SALARY_ENCRYPTION_KEY",
  "MARKETING_CHANNEL_ID_SECRET",
  "JWT_SECRET",
]);

/* ── A CONFIGURATION PROBLEM, NOT A REFUSAL OF THE CALLER ───────────────────
   Thrown rather than returned, because there is no sensible half-answer: a
   caller that got `null` back would have to decide what to do, and the only
   safe decision is the one made here. */
class WebhookKeyUnavailable extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = "WebhookKeyUnavailable";
    this.code = code;
    this.detail = detail;
    /* An administrator can fix it; a marketer cannot, and must never see it. */
    this.administratorOnly = true;
  }
}

const str = (v) => String(v ?? "").trim();

/**
 * Read and validate one generation's master secret.
 *
 * One format: 64 hexadecimal characters, 32 bytes. Generate with
 * `openssl rand -hex 32`.
 */
function masterFor(version, env) {
  const name = KEY_RING[version];
  if (!name) {
    /* ── FAIL CLOSED ON AN UNKNOWN GENERATION ───────────────────────────
       A binding recorded a version this build does not know. Deriving with
       the newest master instead would produce a key that verifies nothing,
       and every delivery for that form would be refused as a bad secret —
       sending somebody to look for an attacker who is not there. */
    throw new WebhookKeyUnavailable("unknown_key_version",
      `This delivery binding was created with webhook key version ${version}, which this build does not know about.`,
      { version, known: Object.keys(KEY_RING) });
  }

  const raw = str(env[name]);
  if (!raw) {
    /* Likewise: an OLD master that is no longer configured must fail, not
       quietly fall through to the current one. */
    throw new WebhookKeyUnavailable("master_secret_missing",
      `The webhook master secret for version ${version} is not configured.`,
      { version, variable: name });
  }

  /* ── ONE EXACT FORMAT, NOT A JUDGEMENT ABOUT RANDOMNESS ────────────────
     64 hexadecimal characters, decoding to exactly 32 bytes. Nothing else.

     An earlier version of this scored the supplied value — distinct bytes,
     then repeated windows — trying to tell a real secret from a placeholder.
     That was the wrong shape of check twice over. It cannot succeed: a
     genuinely random 32-byte key is indistinguishable from any other 32 bytes,
     so anything that "detects randomness" is really detecting the handful of
     patterns its author thought of, and quietly accepts the next placeholder
     nobody predicted. Meanwhile it rejects material that is perfectly fine for
     looking unusual, which teaches an operator to work around the check.

     A format rule has neither failure. `openssl rand -hex 32` satisfies it,
     every placeholder anybody types does not, and what is accepted or refused
     is stated rather than inferred. */
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new WebhookKeyUnavailable("master_secret_malformed",
      `The webhook master secret for version ${version} must be exactly 64 hexadecimal characters, which is 32 bytes. Generate one with a cryptographically secure random generator: openssl rand -hex 32`,
      /* The LENGTH of what was supplied, never the value — and not even the
         length when it might itself be sensitive. */
      { version, variable: name });
  }

  const material = Buffer.from(raw, "hex");
  if (material.length !== MASTER_BYTES) {
    throw new WebhookKeyUnavailable("master_secret_malformed",
      `The webhook master secret for version ${version} must decode to exactly ${MASTER_BYTES} bytes.`,
      { version, variable: name });
  }

  /* ── THE ONE PLACEHOLDER THE FORMAT RULE CANNOT CATCH ──────────────────
     `0000…`, `ffff…` and `aaaa…` are all valid 64-character hex. This is not
     randomness scoring making a comeback — it is a single exact check for a
     value with one repeated character, which is what somebody types when they
     want the variable to be "set" and mean nothing. Anything else is accepted
     on its format alone. */
  if (/^(.)\1{63}$/.test(raw)) {
    throw new WebhookKeyUnavailable("master_secret_malformed",
      `The webhook master secret for version ${version} is a placeholder. Generate one with a cryptographically secure random generator: openssl rand -hex 32`,
      { version, variable: name });
  }

  return material;
}

/* ── LENGTH-PREFIXED, SO TWO INPUTS CANNOT LOOK ALIKE ───────────────────────
   Concatenating fields is the classic mistake: ("ab","c") and ("a","bc") give
   the same bytes, so two different bindings could derive the same key. Every
   field carries its own byte length in front of it, which makes the encoding
   unambiguous whatever the values are. */
function canonical(fields) {
  const parts = [];
  for (const field of fields) {
    const bytes = Buffer.from(String(field), "utf8");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length, 0);
    parts.push(length, bytes);
  }
  return Buffer.concat(parts);
}

/**
 * The webhook key for one company's one delivery binding.
 *
 * Deterministic: the same inputs always give the same key, which is the whole
 * mechanism — GRAV configures it once at Google and recomputes it on every
 * delivery rather than keeping it anywhere.
 *
 * @param {object} args
 * @param {string} args.companyId   the company this binding belongs to
 * @param {string} args.bindingId   the stable delivery-binding identity
 * @param {number} [args.version]   the generation recorded on the binding
 * @param {object} [args.env]       injected for tests
 * @returns {string} a Google-compatible text key
 */
function deriveWebhookKey({ companyId, bindingId, version = CURRENT_VERSION, env = process.env } = {}) {
  const company = str(companyId);
  const binding = str(bindingId);

  /* Both are load-bearing. An empty one would make every binding with an empty
     value share a key, which is the failure this function exists to prevent. */
  if (!company) {
    throw new WebhookKeyUnavailable("company_required",
      "A webhook key cannot be derived without a company.");
  }
  if (!binding) {
    throw new WebhookKeyUnavailable("binding_required",
      "A webhook key cannot be derived without a delivery binding.");
  }

  const generation = Number(version);
  if (!Number.isInteger(generation) || generation < 1) {
    throw new WebhookKeyUnavailable("unknown_key_version",
      "That is not a webhook key version.", { version });
  }

  const master = masterFor(generation, env);

  /* HKDF-SHA-256. The purpose is the salt, so two purposes over one master
     produce unrelated keys; the identity is the info, length-prefixed. The
     version appears in BOTH — in the purpose string and in the bound fields —
     so a change to either produces a different key. */
  const derived = crypto.hkdfSync(
    "sha256",
    master,
    Buffer.from(PURPOSE, "utf8"),
    canonical([PURPOSE, company, binding, String(generation)]),
    DERIVED_BYTES,
  );

  /* Google stores this as text on the form. base64url is 43 characters with no
     padding and nothing that needs escaping in a form field or a JSON body. */
  return Buffer.from(derived).toString("base64url");
}

/**
 * Verify a supplied key against the one this binding should have.
 *
 * ── THE COMPARISON LIVES HERE TOO ──────────────────────────────────────────
 * Not because the caller could not do it, but because handing a caller the
 * derived key so it can compare is the one moment the secret exists outside
 * this module — in a variable somebody may later log, return in an error, or
 * put on an object that gets serialised. Passing the candidate IN instead means
 * the derived value never leaves.
 */
function verifyWebhookKey({ supplied, companyId, bindingId, version, env } = {}) {
  const expected = deriveWebhookKey({ companyId, bindingId, version, env });

  /* Hashed first so the comparison is over a constant 32 bytes whatever was
     supplied — `timingSafeEqual` throws on a length mismatch, and the throw
     would itself reveal the length. */
  const a = crypto.createHash("sha256").update(String(supplied ?? ""), "utf8").digest();
  const b = crypto.createHash("sha256").update(expected, "utf8").digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * Whether a generation is usable, without deriving anything.
 *
 * For an administrator's configuration screen. It reports the variable NAME
 * and never a value, and never whether a given key is correct.
 */
function availability({ version = CURRENT_VERSION, env = process.env } = {}) {
  try {
    masterFor(Number(version), env);
    return { available: true, version: Number(version) };
  } catch (err) {
    return {
      available: false,
      version: Number(version),
      reason: err.code,
      /* The variable an administrator has to set. Never its value. */
      variable: KEY_RING[Number(version)] || null,
      means: err.message,
    };
  }
}

module.exports = {
  deriveWebhookKey,
  verifyWebhookKey,
  availability,
  WebhookKeyUnavailable,
  CURRENT_VERSION,
  KEY_RING,
  PURPOSE,
  MASTER_BYTES,
  MASTER_HEX_CHARS,
  FORBIDDEN_SOURCES,
};
