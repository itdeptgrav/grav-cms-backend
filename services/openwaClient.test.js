"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { cfg } = require("../config/whatsappProvider");
const client = require("./openwaClient");
const { parseOpenWaInbound } = require("./whatsappStore");

const originalFetch = global.fetch;
const original = { ...cfg };

test.afterEach(() => {
  global.fetch = originalFetch;
  Object.assign(cfg, original);
});

test("sendText targets the OpenWA Easy API with an authenticated personal chat id", async () => {
  Object.assign(cfg, { provider: "openwa", openwaBaseUrl: "http://openwa.test", openwaApiKey: "secret", openwaDefaultCountryCode: "91", requestTimeoutMs: 1000 });
  let call;
  global.fetch = async (url, options) => {
    call = { url, options };
    return { ok: true, json: async () => ({ success: true, data: "openwa-message-id" }) };
  };

  assert.equal(await client.sendText("+91 98765 43210", "Quotation ready"), "openwa-message-id");
  assert.equal(call.url, "http://openwa.test/api/sendText");
  assert.equal(call.options.headers["X-API-Key"], "secret");
  assert.deepEqual(JSON.parse(call.options.body), {
    to: "919876543210@c.us",
    content: "Quotation ready",
    text: "Quotation ready",
  });
});

test("sendText adds the default country code to local Indian mobile numbers", async () => {
  Object.assign(cfg, { provider: "openwa", openwaBaseUrl: "http://openwa.test", openwaApiKey: "secret", openwaDefaultCountryCode: "91", requestTimeoutMs: 1000 });
  let body;
  global.fetch = async (_url, options) => {
    body = JSON.parse(options.body);
    return { ok: true, json: async () => ({ success: true, data: "openwa-message-id" }) };
  };

  await client.sendText("09876543210", "Hello");
  assert.equal(body.to, "919876543210@c.us");
});

test("the OpenWA client fails closed when the provider is dormant", async () => {
  cfg.provider = "meta";
  global.fetch = async () => { throw new Error("must not be called"); };
  await assert.rejects(() => client.sendText("919876543210", "Hello"), (error) => error.code === "provider_dormant");
});

test("parseOpenWaInbound accepts the current v5 webhook envelope", () => {
  const parsed = parseOpenWaInbound({
    event: "message.received",
    sessionId: "sales",
    payload: { message: {
      id: "false_919876543210@c.us_ABC",
      from: "919876543210@c.us",
      body: "Need 200 uniforms",
      type: "chat",
      timestamp: 1791792000,
      fromMe: false,
      isGroupMsg: false,
      sender: { pushname: "Hotel Buyer" },
    } },
  });
  assert.equal(parsed.waId, "919876543210");
  assert.equal(parsed.name, "Hotel Buyer");
  assert.equal(parsed.parsed.type, "text");
  assert.equal(parsed.parsed.text, "Need 200 uniforms");
});

test("parseOpenWaInbound resolves a multi-device LID to the sender phone number", () => {
  const parsed = parseOpenWaInbound({
    event: "message.received",
    sessionId: "sales",
    payload: { message: {
      id: "false_29042753462282@lid_ABC",
      from: "29042753462282@lid",
      body: "Hello",
      type: "chat",
      timestamp: 1791792000,
      sender: {
        phoneNumber: "919861690346@c.us",
        lid: "29042753462282@lid",
        formattedName: "Ramesh Latest",
      },
    } },
  });
  assert.equal(parsed.waId, "919861690346");
  assert.equal(parsed.name, "Ramesh Latest");
});

test("parseOpenWaInbound stores media metadata without treating its base64 thumbnail as text", () => {
  const parsed = parseOpenWaInbound({
    event: "message.received",
    sessionId: "sales",
    payload: { message: {
      id: "false_919876543210@c.us_MEDIA",
      from: "919876543210@c.us",
      body: "/9j/4AAQSkZJRgABAQAAAQABAAD...",
      caption: "Factory sample",
      type: "image",
      mimetype: "image/jpeg",
      isMedia: true,
      timestamp: 1791792000,
    } },
  });
  assert.equal(parsed.parsed.type, "image");
  assert.equal(parsed.parsed.text, "Factory sample");
  assert.equal(parsed.parsed.media.id, "false_919876543210@c.us_MEDIA");
  assert.equal(parsed.parsed.media.mimeType, "image/jpeg");
  assert.equal(parsed.parsed.media.url, undefined);
});

test("downloadMedia returns protected OpenWA bytes and their content type", async () => {
  Object.assign(cfg, { provider: "openwa", openwaBaseUrl: "http://openwa.test", openwaApiKey: "secret", requestTimeoutMs: 1000 });
  let call;
  global.fetch = async (url, options) => {
    call = { url, options };
    return new Response(Buffer.from("media-bytes"), { status: 200, headers: { "Content-Type": "audio/ogg" } });
  };
  const file = await client.downloadMedia("false_919@c.us_ABC");
  assert.equal(call.url, "http://openwa.test/api/media/false_919%40c.us_ABC");
  assert.equal(call.options.headers["X-API-Key"], "secret");
  assert.equal(file.mimeType, "audio/ogg");
  assert.equal(file.buffer.toString(), "media-bytes");
});

test("qrCode fetches the pairing credential only from OpenWA's private QR surface", async () => {
  Object.assign(cfg, { provider: "openwa", openwaBaseUrl: "http://openwa.test", openwaApiKey: "secret", openwaSessionId: "company", requestTimeoutMs: 1000 });
  let call;
  global.fetch = async (url, options) => {
    call = { url, options };
    return new Response(JSON.stringify({ qr: "pairing-payload" }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  assert.deepEqual(await client.qrCode(), { qr: "pairing-payload" });
  assert.equal(call.url, "http://openwa.test/qr?sessionId=company");
  assert.equal(call.options.headers["X-API-Key"], "secret");
  assert.equal(call.options.cache, "no-store");
});

test("qrCode accepts an image response without writing it anywhere", async () => {
  Object.assign(cfg, { provider: "openwa", openwaBaseUrl: "http://openwa.test", openwaApiKey: "secret", requestTimeoutMs: 1000 });
  global.fetch = async () => new Response(Buffer.from("png"), { status: 200, headers: { "Content-Type": "image/png" } });

  const result = await client.qrCode();
  assert.match(result.image, /^data:image\/png;base64,/);
});

test("parseOpenWaInbound ignores group and self-authored events", () => {
  assert.equal(parseOpenWaInbound({ event: "message.received", payload: { message: { from: "123@g.us", body: "group" } } }), null);
  assert.equal(parseOpenWaInbound({ event: "message.received", payload: { message: { from: "919876543210@c.us", body: "mine", fromMe: true } } }), null);
});
