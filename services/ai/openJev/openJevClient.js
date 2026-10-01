"use strict";
/**
 * services/ai/openJev/openJevClient.js — the adapter to an Open-Jev server.
 *
 * Contract (Open-Jev jev/client.py + jev/api.py, main branch, 22 Sep 2026):
 *
 *   POST {url}   Content-Type: application/json
 *   { "model": "open-jev", "state": <text|object>,
 *     "questions": { "<id>": { "type": "choice", "instructions": <text>,
 *                              "criteria": { "<candidate>": <description> } } } }
 *
 *   200 → { "answers": { "<id>": { "type": "choice", "choice": "<candidate>",
 *                                  "probabilities": { "<candidate>": p, … },
 *                                  "confidence": c } },
 *           "model": "...", "usage": {...}, "metadata": {...} }
 *
 * WHAT THE MODEL IS GIVEN: the user's question text and the intents GRAV is
 * prepared to offer this user. No credentials, no connection string, no
 * collection names, no records, no conversation history, no employee directory.
 *
 * WHAT THE RESULT IS: a routing suggestion. It is never an attendance fact and
 * never an authorisation decision — the caller re-checks permission and reads
 * the authoritative record regardless of what comes back.
 *
 * Every failure is a typed status, never a throw, so an unavailable or
 * misbehaving server can only ever mean "use the existing path".
 */

const STATUS = Object.freeze({
  OK: "ok",
  UNAVAILABLE: "unavailable", // connection refused, DNS, non-2xx
  TIMEOUT: "timeout",
  INVALID: "invalid", // response failed schema validation
});

const QUESTION_ID = "route";
const SUM_TOLERANCE = 1e-4;

/**
 * Strictly validate an Open-Jev response against the candidates GRAV offered.
 * Returns { ok:true, choice, probabilities } or { ok:false, reason }.
 */
function validateChoiceResponse(body, candidates) {
  const fail = (reason) => ({ ok: false, reason });
  if (!body || typeof body !== "object" || Array.isArray(body)) return fail("body_not_object");
  const answers = body.answers;
  if (!answers || typeof answers !== "object") return fail("missing_answers");
  const ids = Object.keys(answers);
  if (ids.length !== 1 || ids[0] !== QUESTION_ID) return fail("unexpected_answer_ids");
  const a = answers[QUESTION_ID];
  if (!a || a.type !== "choice") return fail("not_a_choice_answer");
  if (typeof a.choice !== "string" || !candidates.includes(a.choice)) return fail("choice_not_offered");
  const probs = a.probabilities;
  if (!probs || typeof probs !== "object") return fail("missing_probabilities");
  const keys = Object.keys(probs);
  if (keys.length !== candidates.length || !candidates.every((c) => keys.includes(c))) {
    return fail("probability_keys_mismatch");
  }
  let sum = 0;
  let argmax = null;
  for (const c of candidates) {
    const p = probs[c];
    if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) return fail("probability_out_of_range");
    sum += p;
    if (argmax === null || p > probs[argmax]) argmax = c;
  }
  if (Math.abs(sum - 1) > SUM_TOLERANCE) return fail("probabilities_do_not_sum_to_one");
  if (probs[a.choice] < probs[argmax]) return fail("choice_is_not_argmax");
  return { ok: true, choice: a.choice, probabilities: { ...probs } };
}

/**
 * Ask Open-Jev to choose one intent.
 *
 * @param {object} input
 * @param {string} input.question                 the user's message, verbatim
 * @param {Record<string,string>} input.intents   candidate → description
 * @param {string} input.instructions
 * @param {object} cfg                            { url, timeoutMs }
 * @param {Function} [fetchImpl]
 * @returns {Promise<{status:string, reason?:string, choice?:string,
 *   probabilities?:object, provenance?:object, latencyMs:number}>}
 */
async function chooseIntent({ question, intents, instructions }, cfg, fetchImpl = globalThis.fetch) {
  const started = Date.now();
  const candidates = Object.keys(intents || {});
  const done = (extra) => ({ ...extra, latencyMs: Date.now() - started });
  if (!candidates.length || typeof question !== "string" || !question.trim()) {
    return done({ status: STATUS.INVALID, reason: "empty_request" });
  }

  const body = {
    model: "open-jev",
    state: { question },
    questions: { [QUESTION_ID]: { type: "choice", instructions, criteria: { ...intents } } },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  let res;
  try {
    res = await fetchImpl(cfg.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const aborted = err && err.name === "AbortError";
    return done({ status: aborted ? STATUS.TIMEOUT : STATUS.UNAVAILABLE, reason: aborted ? "timeout" : "network_error" });
  }

  let parsed;
  try {
    if (!res || !res.ok) {
      clearTimeout(timer);
      return done({ status: STATUS.UNAVAILABLE, reason: `http_${res ? res.status : "none"}` });
    }
    parsed = await res.json();
  } catch (err) {
    clearTimeout(timer);
    const aborted = err && err.name === "AbortError";
    return done({ status: aborted ? STATUS.TIMEOUT : STATUS.INVALID, reason: aborted ? "timeout" : "body_not_json" });
  }
  clearTimeout(timer);

  const v = validateChoiceResponse(parsed, candidates);
  if (!v.ok) return done({ status: STATUS.INVALID, reason: v.reason });

  const meta = parsed.metadata && typeof parsed.metadata === "object" ? parsed.metadata : {};
  return done({
    status: STATUS.OK,
    choice: v.choice,
    probabilities: v.probabilities,
    // What GRAV records about WHICH model decided — never what it was asked.
    provenance: {
      model: typeof parsed.model === "string" ? parsed.model.slice(0, 200) : null,
      method: typeof meta.method === "string" ? meta.method.slice(0, 100) : null,
      temperature: Number.isFinite(meta.temperature) ? meta.temperature : null,
      checkpointSha256:
        meta.provenance && typeof meta.provenance.checkpoint_sha256 === "string"
          ? meta.provenance.checkpoint_sha256.slice(0, 64)
          : null,
    },
  });
}

module.exports = { chooseIntent, validateChoiceResponse, STATUS, QUESTION_ID };
