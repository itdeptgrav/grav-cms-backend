"use strict";

const crypto = require("crypto");
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  dialXml,
  dialStatusUrl,
  liveKitSipEndpoint,
  liveKitSipUri,
  publicRequestUrl,
  signaturePayload,
  validPlivoRequest,
  validV3Signature,
} = require("./plivoInboundBridge");

test("a LiveKit cloud URL becomes its regional SIP endpoint", () => {
  const env = { LIVEKIT_URL: "wss://meet-f96q3m0l.livekit.cloud" };
  assert.equal(liveKitSipEndpoint(env), "f96q3m0l.india.sip.livekit.cloud");
  assert.equal(
    liveKitSipUri("+918065395337", env),
    "sip:+918065395337@f96q3m0l.india.sip.livekit.cloud;transport=tcp",
  );
});

test("a dedicated Voice project overrides the legacy shared LiveKit project", () => {
  assert.equal(liveKitSipEndpoint({
    LIVEKIT_URL: "wss://legacy.livekit.cloud",
    GRAV_VOICE_LIVEKIT_URL: "wss://grav-rpz9c01j.livekit.cloud",
  }), "grav-rpz9c01j.india.sip.livekit.cloud");
});

test("the Plivo answer contains only a bounded Dial to the assigned DID", () => {
  const xml = dialXml({
    number: "+918065395337",
    timeout: 999,
    env: { GRAV_VOICE_LIVEKIT_SIP_ENDPOINT: "sips://sip.example.com" },
  });
  assert.equal(
    xml,
    '<?xml version="1.0" encoding="UTF-8"?><Response><Dial timeout="120"><User>sip:+918065395337@sip.example.com;transport=tcp</User></Dial></Response>',
  );
  assert.equal(dialXml({ number: "not-a-number", env: { GRAV_VOICE_LIVEKIT_SIP_ENDPOINT: "sip.example.com" } }), null);
});

test("the Dial action returns to the same public ingress without forwarding query data", () => {
  const req = {
    protocol: "http",
    originalUrl: "/api/cms/voice/plivo/inbound?debug=1",
    get(name) {
      return { "x-forwarded-proto": "https", "x-forwarded-host": "voice.example.com" }[name];
    },
  };
  assert.equal(dialStatusUrl(req), "https://voice.example.com/api/cms/voice/plivo/inbound/status");
  assert.equal(
    dialXml({
      number: "+918065395337",
      actionUrl: dialStatusUrl(req),
      env: { GRAV_VOICE_LIVEKIT_SIP_ENDPOINT: "sip.example.com" },
    }),
    '<?xml version="1.0" encoding="UTF-8"?><Response><Dial timeout="45" action="https://voice.example.com/api/cms/voice/plivo/inbound/status" method="POST"><User>sip:+918065395337@sip.example.com;transport=tcp</User></Dial></Response>',
  );
});

test("V3 POST signatures sort form parameters and accept token rotation lists", () => {
  const method = "POST";
  const url = "https://api.grav.in/api/cms/voice/plivo/inbound?edge=mumbai";
  const nonce = "nonce-123";
  const params = { To: "+918065395337", CallUUID: "call-1", From: "+919999999999" };
  const authToken = "secret";
  assert.equal(
    signaturePayload(method, url, nonce, params),
    `${url}CallUUIDcall-1From+919999999999To+918065395337${nonce}`,
  );
  const expected = crypto.createHmac("sha256", authToken)
    .update(signaturePayload(method, url, nonce, params))
    .digest("base64");
  assert.equal(validV3Signature({ method, url, nonce, params, authToken, signature: `old, ${expected}` }), true);
  assert.equal(validV3Signature({ method, url, nonce, params: { ...params, To: "+910000000000" }, authToken, signature: expected }), false);
});

test("the external URL honors proxy headers and signature enforcement is explicit", () => {
  const req = {
    method: "POST",
    protocol: "http",
    originalUrl: "/api/cms/voice/plivo/inbound",
    body: { To: "+918065395337" },
    get(name) {
      return {
        "x-forwarded-proto": "https",
        "x-forwarded-host": "api.grav.in",
        host: "localhost:5050",
      }[name];
    },
  };
  assert.equal(publicRequestUrl(req), "https://api.grav.in/api/cms/voice/plivo/inbound");
  assert.equal(validPlivoRequest(req, {}), true);
  assert.equal(validPlivoRequest(req, { GRAV_VOICE_PLIVO_REQUIRE_SIGNATURE: "1" }), false);

  const nonce = "main-account-nonce";
  const authToken = "main-token";
  const signature = crypto.createHmac("sha256", authToken)
    .update(signaturePayload(req.method, publicRequestUrl(req), nonce, req.body))
    .digest("base64");
  const signedReq = {
    ...req,
    get(name) {
      if (name === "x-plivo-signature-v3-nonce") return nonce;
      if (name === "x-plivo-signature-v3") return "wrong-associated-account-signature";
      if (name === "x-plivo-signature-ma-v3") return signature;
      return req.get(name);
    },
  };
  assert.equal(validPlivoRequest(signedReq, { PLIVO_AUTH_TOKEN: authToken }), true);
});
