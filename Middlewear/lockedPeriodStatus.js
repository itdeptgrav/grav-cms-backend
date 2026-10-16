"use strict";

/**
 * Locked-period refusals answer 423 everywhere (15–16 Oct 2026).
 *
 * The period lock is enforced on the models (services/accounting/fyLock.js),
 * so a write into a locked period fails inside whichever route made it — and
 * each of the ~50 accounting routes has its own catch: most answer
 * `400 { error: e.message }` or 500, some a fixed "Error reconciling
 * transaction" that hides the reason altogether.
 *
 * This runs each accounting request inside the guard's request context and
 * wraps `res.json` once. An error response goes out as 423 with
 * `code: "FY_LOCKED"` and the lock's own sentence (which period, which
 * section, who locked it and why) when
 *   • its message IS the guard's sentence, or
 *   • the guard refused something during this request (the route's catch
 *     replaced the message with its own words).
 * Every other response passes untouched.
 */

const { lockContext } = require("../services/accounting/fyLock");

const LOCK_SENTENCE = /\b(?:is|are) (?:locked|frozen)\b[\s\S]*Nothing in a (?:locked month|locked period|frozen year) can be created, changed or deleted/;

function messageOf(body) {
  if (!body || typeof body !== "object") return "";
  for (const k of ["error", "message", "msg"]) if (typeof body[k] === "string") return body[k];
  if (body.error && typeof body.error.message === "string") return body.error.message;
  return "";
}

function lockedPeriodStatus(req, res, next) {
  const store = {};
  const json = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode >= 400 && res.statusCode !== 423 && res.statusCode !== 401 && res.statusCode !== 403 && res.statusCode !== 404) {
      const msg = messageOf(body);
      if (msg && LOCK_SENTENCE.test(msg)) {
        res.status(423);
        if (body && typeof body === "object" && !body.code) body = { ...body, code: "FY_LOCKED" };
      } else if (store.error) {
        const e = store.error;
        res.status(423);
        body = { ...(body && typeof body === "object" ? body : {}), success: false, error: e.message, message: e.message, code: "FY_LOCKED", period: e.period, section: e.section };
      }
    }
    return json(body);
  };
  lockContext.run(store, next);
}

module.exports = { lockedPeriodStatus, LOCK_SENTENCE };
