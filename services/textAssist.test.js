const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

/**
 * Reported 17 Aug 2026: the mail composer's grammar gate showed "The assistant
 * could not reach Gemini" and the console showed 502 Bad Gateway. Neither was
 * true. Google answered every request — with 401, because the value in
 * GEMINI_API_KEY was not a Gemini key. "Could not reach" sends somebody to
 * check their network; 502 blames the upstream. The fault was local
 * configuration, and nothing on the screen or in the log said so.
 */

const service = fs.readFileSync(require.resolve("./textAssist.service.js"), "utf8");
const route = fs.readFileSync(
  require.resolve("../routes/task_routes/textImprove.routes.js"),
  "utf8",
);

test("a rejected key is reported as a key problem, not an unreachable server", () => {
  assert.match(service, /reason: "bad_key"/);
  assert.match(service, /Google rejected the assistant's API key/);
  assert.match(service, /GEMINI_API_KEY/);
  /* The patterns Google actually returns for a refused credential. */
  for (const signal of ["401", "403", "UNAUTHENTICATED", "PERMISSION_DENIED", "API_KEY_INVALID"]) {
    assert.ok(
      service.includes(signal),
      `${signal} is no longer matched — that failure will read as "could not reach Gemini" again`,
    );
  }
});

test("the underlying error is logged rather than swallowed", () => {
  /* Without this, the only way to learn why the assistant failed is to call
     Google by hand — which is how this bug was actually diagnosed. */
  assert.match(service, /console\.error\("\[textAssist\] Gemini call failed:"/);
});

test("a credential fault answers 503, not 502", () => {
  /* 502 says the upstream is broken. It is not: this server is misconfigured,
     which is exactly what `not_configured` already meant. */
  assert.match(
    route,
    /outcome\.reason === "not_configured" \|\| outcome\.reason === "bad_key"[\s\S]{0,40}503/,
  );
});

test("quota is still distinguished from both", () => {
  /* Rate limiting is transient and needs neither a new key nor a restart. */
  assert.match(service, /reason: "quota"/);
  assert.match(service, /RESOURCE_EXHAUSTED/);
  assert.match(route, /outcome\.reason === "quota"[\s\S]{0,30}429/);
});
