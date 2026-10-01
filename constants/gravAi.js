// constants/gravAi.js
//
// THE GRAV AI GATEWAY'S VOCABULARY.
//
// ── PROVIDER-NEUTRAL ON PURPOSE ────────────────────────────────────────────
// Gemini is today's configured model. It is named in exactly one adapter and
// nowhere else — not in a Marketing service, not in a route, not in a stored
// record's field names. A later CMS module asking for an explanation should not
// have to know which company's model answers it, and swapping the provider
// should be an adapter and a configuration line rather than a search across the
// codebase.
//
// ── A CLOSED OPERATION TABLE, NOT A CHAT ENDPOINT ──────────────────────────
// There is no `ask(prompt)` here. An operation is a named, versioned contract:
// a fixed system prompt GRAV wrote, a schema GRAV validates against, its own
// token ceilings, and its own allow-list of what the answer may contain.
//
// A caller supplies evidence. It cannot supply a model, a URL, a system prompt,
// a temperature, a tool or a generation setting — because every one of those is
// a way to turn a narrow, auditable capability into a general one, and the
// moment it is general nobody can say what it is allowed to do.
//
// ── AND THE MODEL EXPLAINS. IT DOES NOT CALCULATE. ─────────────────────────
// Every number an operation's answer refers to was computed by GRAV before the
// model was called, and is referenced by an evidence id the model must cite. A
// language model asked to compute a percentage change will produce one that
// looks right and sometimes is not, and nobody checks a plausible number.
"use strict";

const freeze = Object.freeze;
const pair = (code, label, extra = {}) => freeze({ code, label, ...extra });
const codes = (list) => freeze(list.map((x) => x.code));

/* ── WHERE THE KEY LIVES, AND WHERE IT DOES NOT ─────────────────────────────
   Deployment secrets. Never a database document, never a request body, never a
   response, never a log line. The variable NAME may be published in an
   administrator's diagnostic — that is how somebody fixes a missing one — but
   the value never leaves the adapter that uses it. */
const API_KEY_VAR = "GEMINI_API_KEY";

/* ── THE MODEL, BY CONFIGURATION ────────────────────────────────────────────
   Each operation names a default; the environment may override it per
   operation. What the environment may NOT do is let a request choose, which is
   why the override is read here from a fixed variable name rather than passed
   in. */
const MODEL_VAR = "MARKETING_AI_MODEL";
const DEFAULT_MARKETING_MODEL = "gemini-3.8-flash";

/* ── THE PROVIDERS THIS GATEWAY CAN SPEAK TO ────────────────────────────────
   One, today. Listed as a table so adding a second is an entry and an adapter
   rather than an edit to every caller. */
const PROVIDERS = [
  pair("google_gemini", "Google Gemini", {
    keyVar: API_KEY_VAR,
    /* Named here so no Marketing file has to. */
    endpointHost: "generativelanguage.googleapis.com",
  }),
];
const PROVIDER_CODES = codes(PROVIDERS);

/* ── THE COMPLETE SET OF THINGS GRAV WILL ASK A MODEL ───────────────────────
   One operation. A second needs an entry here, its own system prompt, its own
   schema and its own tests — which is the point: a capability nobody had to
   declare is a capability nobody reviewed. */
const OPERATIONS = [
  pair("marketing_campaign_health", "Campaign health adviser", {
    provider: "google_gemini",
    defaultModel: DEFAULT_MARKETING_MODEL,
    modelVar: MODEL_VAR,
    /* Versioned. A changed prompt is a changed analysis, and a stored result
       that does not say which prompt produced it cannot be compared with a
       later one. */
    promptVersion: "campaign-health-1.0.0",
    /* Bounded both ways. The input bound stops an evidence packet growing into
       a cost nobody predicted; the output bound stops a model rambling into a
       response somebody has to render. */
    maxInputTokens: 8000,
    maxOutputTokens: 1500,
    timeoutMs: 20000,
    /* One retry, and only for a transport fault. A model that answered badly
       will answer badly again, and retrying a refusal wastes tokens to arrive
       at the same place. */
    retries: 1,
  }),
];
const OPERATION_CODES = codes(OPERATIONS);
const OPERATION_BY_CODE = freeze(Object.fromEntries(OPERATIONS.map((o) => [o.code, o])));

/* ── WHAT THE GATEWAY WILL NEVER TURN ON ────────────────────────────────────
   Each of these is a real Gemini capability and each would change what this is.
   Grounding and URL context make the model fetch things GRAV has not seen.
   Code execution runs code. Function calling lets a model invoke something —
   and the entire safety argument for this slice is that the model can suggest
   and cannot act.

   Listed rather than merely omitted, so a future contributor enabling one has
   to delete a line that says why not. */
const DISABLED_CAPABILITIES = freeze([
  pair("google_search_grounding", "Google Search grounding", {
    why: "It would put text GRAV never saw into an answer about a company's own campaign, with no way to check where it came from.",
  }),
  pair("url_context", "URL context", {
    why: "Same problem, plus it would fetch a URL on GRAV's behalf.",
  }),
  pair("code_execution", "Code execution", {
    why: "GRAV calculates; the model explains. There is nothing here for it to run.",
  }),
  pair("function_calling", "Function calling", {
    why: "The whole safety argument is that the model can suggest and cannot act. A callable function is the model acting.",
  }),
  pair("external_tools", "Any external tool", { why: "As above." }),
]);
const DISABLED_CAPABILITY_CODES = codes(DISABLED_CAPABILITIES);

/* ── WHAT MUST NEVER BE IN A PROMPT ─────────────────────────────────────────
   The model is sent GRAV's own calculated facts and nothing that identifies a
   person, an account or a row. Two reasons, and the second is the one people
   forget: the obvious one is privacy, and the other is that a provider's
   retention and a provider's logs are outside GRAV's control entirely.

   Enforced by scanning the built packet before transport, not by trusting the
   builder — a builder is one edit away from including a field nobody noticed.

   ── THESE APPLY TO TEXT, NOT TO MEASUREMENTS ─────────────────────────────
   Every kind of data below reaches GRAV as a string: an email, a destination
   address, a document id, an account number. A JSON *number* in this packet is
   something GRAV calculated — a spend in micros, a ratio, a count.

   That distinction is not a nicety, it is the whole difference between a guard
   that works and one that gets deleted. Scanning the serialised packet meant
   `spendMicros: 5000000000` (an ordinary ₹5,000) read as a phone number, and a
   ratio of `-0.37499999999` read as one too. A guard that refuses ordinary
   traffic gets reported as "the assistant is broken", and the fix somebody
   reaches for at speed is to loosen the pattern — which removes the protection
   for the real phone numbers as well. So the scan walks the structure and
   applies these to string leaves and to key names. */
const FORBIDDEN_IN_PROMPT = freeze([
  /* Ordered most specific first. A Google Ads account number also has the
     shape of a phone number, and the refusal an operator reads should name the
     thing it actually found. */
  pair("email", "An email address", { pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ }),
  pair("database_id", "A database identifier", { pattern: /\b[0-9a-f]{24}\b/i }),
  pair("google_account", "A Google Ads account number", { pattern: /\b\d{3}-\d{3}-\d{4}\b/ }),
  pair("meta_account", "A Meta advertising account", { pattern: /\bact_\d{6,}\b/ }),
  pair("api_key", "A credential", { pattern: /\bAIza[0-9A-Za-z_-]{10,}\b|\bEAA[A-Za-z0-9]{10,}\b|\bya29\.[\w-]+/ }),
  pair("url", "A web address", { pattern: /https?:\/\/\S+/ }),
  /* Last, and the broadest. Requires a real phone's shape — a country prefix,
     separators, or an Indian mobile's leading 6-9 — rather than "ten or more
     digits in a row", which is also what a spend in micros looks like. */
  pair("phone", "A phone number", {
    pattern: /\+\d{1,3}[\s-]\d[\d\s-]{7,}\d|\b\d{3,5}[\s-]\d{3,5}[\s-]\d{3,5}\b|\b[6-9]\d{9}\b/,
  }),
]);
const FORBIDDEN_IN_PROMPT_CODES = codes(FORBIDDEN_IN_PROMPT);

/* ── AND A FIELD THAT NAMES AN IDENTIFIER IS REFUSED WHATEVER IT HOLDS ──────
   Checked on the KEY, which is the only reliable signal. A Google campaign id
   is `3001` and a Meta one is `120210000000000` — as values they are
   indistinguishable from an impression count, so no pattern over values can
   separate them. The name can.

   This is what makes the backstop catch the realistic accident: somebody adds
   `externalCampaignId` to the packet to help the model "be specific". The
   value scan would never have seen it. */
const FORBIDDEN_PACKET_KEYS = freeze([
  pair("identifier_field", "A field naming an identifier", {
    pattern: /(^|_)(id|ids)$|Id$|Ids$|^_id$|(^|_)(uid|uuid|ref)$|Uid$/,
  }),
  pair("account_field", "A field naming an external account", {
    pattern: /account|advertiser|customerId|adAccount/i,
  }),
  pair("contact_field", "A field naming a person or a way to reach one", {
    pattern: /email|phone|mobile|contact|address|firstName|lastName|fullName/i,
  }),
  pair("credential_field", "A field naming a credential", {
    pattern: /token|secret|apiKey|api_key|credential|password/i,
  }),
  pair("destination_field", "A field naming a destination", {
    pattern: /^url$|Url$|^link$|destination|landingPage/i,
  }),
]);
const FORBIDDEN_PACKET_KEY_CODES = codes(FORBIDDEN_PACKET_KEYS);

/* The keys GRAV's own evidence uses that would otherwise trip the rules above.
   Short, explicit, and each one a value GRAV calculated rather than one it
   carries about a person or an external object. */
const PACKET_KEY_EXCEPTIONS = freeze([
  "evidenceId", "evidenceIds", "evidenceRefs",
]);

/* ── COST CONTROLS ──────────────────────────────────────────────────────────
   Per company, per operation, per day. Checked BEFORE the call, because a
   ceiling enforced afterwards is an invoice rather than a ceiling.

   Configurable through the environment so an operator can lower them without a
   deploy — raising them is the same act, deliberately, because a ceiling
   somebody can raise silently is not one either. */
const USAGE_LIMITS = freeze({
  DAILY_REQUESTS_VAR: "MARKETING_AI_DAILY_REQUESTS",
  DAILY_TOKENS_VAR: "MARKETING_AI_DAILY_TOKENS",
  DEFAULT_DAILY_REQUESTS: 100,
  DEFAULT_DAILY_TOKENS: 300000,
});

/* ── WHAT GRAV PUBLISHES ABOUT COST ─────────────────────────────────────────
   Tokens, not money. Provider pricing changes independently of this code, a
   hard-coded rate would be wrong the week it changed, and a figure labelled
   "₹4.20" that is wrong is worse than a token count that is right. Whoever
   wants money multiplies tokens by today's published rate. */
const COST_POLICY = freeze({
  publishesCurrency: false,
  why: "Provider pricing changes independently of this code. A hard-coded rate would be wrong the week it changed, and a wrong figure labelled as money is worse than an honest token count.",
});

/* ── WHY AN OPERATION DID NOT RUN, OR DID NOT PRODUCE ANYTHING ──────────────
   GRAV's own codes. A provider message, status or stack never reaches a caller;
   it goes to the server log where a technical operator reads it.

   The distinction that matters most here is `not_configured` against
   `unavailable`. The first is somebody's setup and is fixed in a minute; the
   second is a provider having a bad day. Collapsing them sends an
   administrator to check a key that was fine. */
const FAILURES = [
  pair("not_configured", "Intelligence is not set up", {
    means: "GRAV has no key for the assistant, so it cannot ask for an explanation. Everything else in Marketing works normally.",
    administratorHint: `Set ${API_KEY_VAR} in the server's configuration.`,
  }),
  pair("operation_unknown", "That is not something GRAV asks the assistant", { means: "" }),
  pair("limit_reached", "Today's assistant allowance is used up", {
    means: "This company has reached the number of assistant requests allowed today. It resets tomorrow.",
  }),
  pair("input_too_large", "There is too much to send", {
    means: "GRAV assembled more evidence than it will send in one request.",
  }),
  pair("unsafe_input", "GRAV would not send that", {
    means: "The evidence GRAV assembled contained something it does not send to an outside service. Nothing was sent.",
  }),
  pair("timeout", "The assistant did not answer in time", {
    means: "GRAV stopped waiting. Nothing was saved and nothing was changed.",
  }),
  pair("unavailable", "The assistant is not answering", {
    means: "The service GRAV asks for explanations did not respond. Everything else in Marketing works normally.",
  }),
  pair("refused", "The assistant declined", {
    means: "The service declined to answer this request. Nothing was saved.",
  }),
  pair("malformed_output", "The answer could not be read", {
    means: "GRAV could not make sense of the reply, so it published nothing rather than publish something it could not check.",
  }),
  pair("ungrounded_output", "The answer was not supported by the evidence", {
    means: "The reply referred to something GRAV did not measure, so GRAV published none of it.",
  }),
  pair("forbidden_output", "The answer suggested something GRAV will not offer", {
    means: "The reply proposed an action outside what this assistant may suggest, so GRAV published none of it.",
  }),
];
const FAILURE_CODES = codes(FAILURES);
const FAILURE_BY_CODE = freeze(Object.fromEntries(FAILURES.map((f) => [f.code, f])));

module.exports = freeze({
  API_KEY_VAR,
  MODEL_VAR,
  DEFAULT_MARKETING_MODEL,

  PROVIDERS,
  PROVIDER_CODES,

  OPERATIONS,
  OPERATION_CODES,
  OPERATION_BY_CODE,

  DISABLED_CAPABILITIES,
  DISABLED_CAPABILITY_CODES,
  FORBIDDEN_IN_PROMPT,
  FORBIDDEN_IN_PROMPT_CODES,
  FORBIDDEN_PACKET_KEYS,
  FORBIDDEN_PACKET_KEY_CODES,
  PACKET_KEY_EXCEPTIONS,

  USAGE_LIMITS,
  COST_POLICY,

  FAILURES,
  FAILURE_CODES,
  FAILURE_BY_CODE,
});
