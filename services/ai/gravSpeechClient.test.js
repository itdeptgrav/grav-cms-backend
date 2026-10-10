"use strict";

const assert = require("node:assert/strict");
const crypto = require("crypto");
const test = require("node:test");

test("GRAV Speech signature binds request identity and exact body", () => {
  process.env.GRAV_SPEECH_SHARED_SECRET = "test-secret";
  delete require.cache[require.resolve("./gravSpeechClient")];
  const { _signature } = require("./gravSpeechClient");
  const args = {
    method: "POST",
    path: "/v1/transcription-jobs",
    timestamp: "1000",
    service: "voice",
    companyId: "company-a",
    body: Buffer.from('{"hello":"world"}'),
  };
  const actual = _signature(args);
  const digest = crypto.createHash("sha256").update(args.body).digest("hex");
  const expected = crypto.createHmac("sha256", "test-secret")
    .update([args.method, args.path, args.timestamp, args.service, args.companyId, digest].join("\n"))
    .digest("hex");
  assert.equal(actual, `v1=${expected}`);
  assert.notEqual(actual, _signature({ ...args, companyId: "company-b" }));
});

test("GRAV Speech requests fail with a bounded timeout", async () => {
  const { _fetchWithTimeout } = require("./gravSpeechClient");
  const hangingFetch = (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  });
  await assert.rejects(
    _fetchWithTimeout("http://speech.test/health", {}, { fetchImpl: hangingFetch, timeoutMs: 5 }),
    (error) => error.code === "GRAV_SPEECH_TIMEOUT" && error.status === 504,
  );
});

test("GRAV Speech readiness preserves a model-warming state", async () => {
  process.env.GRAV_SPEECH_API_URL = "http://speech.test";
  process.env.GRAV_SPEECH_SHARED_SECRET = "test-secret";
  const { getReadiness } = require("./gravSpeechClient");
  const status = await getReadiness({
    fetchImpl: async () => new Response(JSON.stringify({ detail: { code: "MODEL_WARMING" } }), {
      status: 503,
      headers: { "content-type": "application/json" },
    }),
  });
  assert.deepEqual(status, { configured: true, ready: false, state: "MODEL_WARMING" });
});
